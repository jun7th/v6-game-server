var EventEmitter = require('events').EventEmitter;
var Room = require('./room.js');
var util = require('util');
var logger = require('./logger.js');

module.exports = GameManager;

function GameManager(server){
    EventEmitter.call(this);

    this.server = server;
    this.engine = server.engine;
    this.defaultEngine = server.defaultEngine;
    this.turnTime = server.conf.turnTime * 1000;
    this.maxTimeouts = server.conf.maxTimeouts;
    this.maxOfflineTimeouts = server.conf.maxOfflineTimeouts;
    this.timeMode = server.conf.timeMode;
    this.timeStartMode = server.conf.timeStartMode;
    this.addTime = server.conf.addTime;
    this.corTime = server.conf.corTime;
    this.clearTimeouts = server.conf.clearTimeouts;
    this.minTurns = server.conf.minTurns;
    this.enableGames = true;

    // bindEvents
    server.on('user_leave', this.onUserDisconnect.bind(this));
    server.on('user_relogin', this.onUserRelogin.bind(this));
    server.inviteManager.on('invite_accepted', this.onInviteAccepted.bind(this));
}

util.inherits(GameManager, EventEmitter);


GameManager.prototype.onMessage = function(message, type){
    var room;
    if (type == 'spectate') {
        room = this.server.storage.getRoom(message.data.roomId);
    } else room = this.getUserRoom(message.sender, type != 'leave');

    if (!room){
        logger.err('GameManager', 'no room to continue', message, 2);
        this.sendError(message.sender, 'no room!');
        return;
    }

    switch (type){
        case 'ready': // player ready to play
            this.setUserReady(room, message.sender, message.data);
            break;
        case 'turn': // all players turns
            this.onUserTurn(room, message.sender, message.data);
            break;
        case 'event': // all events, draw, throw, turn back, others
            this.onUserEvent(room, message.sender, message.data);
            break;
        case 'spectate': // user begin spectate
            this.onUserSpectate(room, message.sender);
            break;
        case 'leave': // user leave room
            if (room.players.indexOf(message.sender) != -1)
                this.onUserLeave(room, message.sender);
            else
                if (room.spectators.indexOf(message.sender) != -1) this.onSpectatorLeave(room, message.sender);
                else logger.err('GameManager.onMessage leave', 'user not a player and not a spectator in room', room.id, 1);
            break;
    }
};


GameManager.prototype.onUserDisconnect = function(user){
    var room = this.getUserRoom(user, true);    // get room where user is player
    if (room && (!room.isPlaying() || this.server.conf.loseOnLeave)) {
        this.onUserLeave(user.currentRoom, user);
    }
    if (!room){
        room = this.getSpectatorRoom(user);   // get room where user is spectator
        if (room){
            this.onSpectatorLeave(room, user);
        }
    }
};


GameManager.prototype.onUserRelogin = function(user){
    var room = user.currentRoom;
    if (room) {
        user.socket.enterRoom(room.id); // new socket enter game room
        this.server.router.send({
            module: 'game_manager',
            type: 'game_restart',
            target: user,
            data: room.getGameData()
        });
        room.game.askDraw = null;
        if (!this.server.conf.reconnectOldGame || !room.isPlaying())
            this.onUserLeave(room, user);
    }
};


GameManager.prototype.onInviteAccepted = function(invite){
    logger.log('GameManager.onInviteAccepted', 'invite_accepted',invite.owner.userId, 3);
    if (!invite.owner || !invite.players || invite.players.length<2 || !invite.data){
        logger.err('GameManager.onInviteAccepted', 'wrong invite!', invite, 1);
        return;
    }
    if (!this.enableGames){
        logger.warn('GameManager.onInviteAccepted', 'new games disabled ', 1);
        return;
    }

    var ip1 = invite.players[0].socket.ip;
    var ip2 = invite.players[1].socket.ip;
    var admin = invite.players[0].isAdmin || invite.players[1].isAdmin;
    logger.log('GameManager.onInviteAccepted', 'ips', ip1, ip2, 3);
    if (!this.server.conf.enableIpGames && ip1 == ip2 && ip1 != null) {
        if (!admin && ip1.indexOf('127.0.0.1') != -1 && ip1.indexOf(':192.168.') != -1){
            logger.warn('GameManager.onInviteAccepted', 'play from one ip ', invite.owner.userId, ip1, 1);
            return;
        }
    }

    // leave spectators room
    var player;
    for (var i = 0; i < invite.players.length; i++){
        player = invite.players[i];
        if (this.getSpectatorRoom(player)){
            this.onSpectatorLeave(player.currentRoom, player);
        }
        if (this.getUserRoom(player)){
            logger.err('GameManager.onInviteAccepted', 'player already in room ', player.userId, 1);
            return;
        }
    }

    this.createGame(invite.owner, invite.players, invite.data);
};


GameManager.prototype.createGame = function(owner, players, data){
    delete data.from;
    delete data.target;
    if (!data.mode) {
        logger.err('GameManager.createGame', 'game mode undefined! wrong invite!', data, owner.userId);
        return;
    }
    var room = this.createRoom(owner, players, data);
    var info = room.getInfo();

    this.server.router.send({
        module: 'server',
        type: 'new_game',
        target: this.server.game,
        data: info
    });

    this.server.storage.pushRoom(room);
};


GameManager.prototype.createRoom = function(owner, players, data){
    var id = this.generateRoomId(owner, data.mode);
    var room = new Room(id, owner, players, data);
    room.saveHistory = data.saveHistory !== false;
    room.saveRating = data.saveRating !== false;
    room.turnTime = data.turnTime*1000 || this.turnTime;
    room.timeMode = data.timeMode || this.timeMode;
    room.timeStartMode =  data.timeStartMode || this.timeStartMode;
    room.addTime = data.addTime || this.addTime;
    if (!room.turnTime || room.turnTime<0) room.turnTime = this.turnTime;
    room.takeBacks = +data.takeBacks || this.server.conf.takeBacks;
    room.maxTimeouts = this.maxTimeouts;
    room.minTurns = this.minTurns;
    for (var i = 0; i < players.length; i++) {
        players[i].enterRoom(room);
    }

    return room;
};


GameManager.prototype.setUserReady = function(room, user, ready){
    logger.log('GameManager.setUserReady room:', room.id, 'user:',  user.userId, ready, 3);
    if (typeof ready != "boolean") ready = true;
    if (room.game.state != "waiting") {
        logger.err('GameManager.setUserReady', 'game already started!', room, user.userId, ready, 1);
        return;
    }
    room.data[user.userId].ready = ready;

    this.server.router.send({
        module: 'game_manager',
        type: 'ready',
        target: room,
        data: {
            user:user.userId,
            ready:ready
        }
    });

    if (room.checkPlayersReady()){ // all users ready
        // initializing game before start, and get data to send players
        var game = room.game;
        game.initData = this.initGame(room);
        game.state = "playing";
        game.history = [];
        game.shistory = "";

        this.server.router.send({
            module: 'game_manager',
            type: 'round_start',
            target: room,
            data: game.initData
        });

        if (typeof this.engine.gameEvent == "function") this.sendEvent(room, this.engine.gameEvent(room, null, null, true));

        if (room.timeStartMode == 'after_round_start'){
            this.updateTime(room, game.current);
        }
    }
};


GameManager.prototype.initGame = function(room) {
    var userData = {
        inviteData: room.inviteData
    };
    // TODO: async initGame and error handler
    if (typeof this.engine.initGame == "function")
        userData = this.engine.initGame(room) || userData;
    if (typeof this.engine.setFirst == "function")
        room.game.first =  this.engine.setFirst(room);
    else
        room.game.first = this.defaultEngine.setFirst(room);
    if (!room.game.first || !room.game.first.userId){
        throw new Error('first player is undefined! '+ room.id)
    }
    room.game.current = room.game.first;
    room.game.askDraw = null;
    room.game.askTakeBack = null;
    room.game.turns = 0;
    room.game.timeouts = 0;
    room.game.timeStart = Date.now();
    room.game.turnStartTime = null;
    room.userTurnTime = null;
    room.corTime = this.corTime;

    userData.first = room.game.current.userId;
    userData.id = room.id;
    userData.owner = room.owner.userId;
    userData.players = [];
    userData.score = room.getScore();
    userData.turnTime = room.turnTime;
    userData.timeMode = room.timeMode;
    userData.timeStartMode = room.timeStartMode;
    userData.addTime = room.addTime;
    userData.saveHistory = room.saveHistory;
    userData.saveRating = room.saveRating;
    for (var i = 0; i < room.players.length; i++) {
        userData.players.push(room.players[i].userId);
        room.data[room.players[i].userId].userTurnTime = room.turnTime;
        room.data[room.players[i].userId].userTotalTime = 0;
        room.data[room.players[i].userId].focusChanged = false;
        room.data[room.players[i].userId].userTurns = 0;
        room.data[room.players[i].userId].userUnfocusedTurns = 0;
    }
    return userData;
};


GameManager.prototype.onUserTurn = function(room, user, turn){
    logger.log('GameManager.onUserTurn room:', room.id, 'user:',  user.userId, 3);
    var game = room.game,
        userTurn,
        isGameEnd,
        nextPlayer;
    if (game.state != 'playing'){
        this.sendError(user, 'game_not_started!');
        return;
    }
    // check user is current, check turn is valid, ask engine what to do, send to all in room
    if (game.current != user) { // wrong user
        this.sendError(user, 'not_your_turn');
        return;
    }

    if (turn.action == 'timeout' || turn.type || turn.nextPlayer || turn.userTurnTime){
        logger.warn('GameManager.onUserTurn, usage some reserved properties in turn: ', turn, user.userId, 1);
    }

    // remove server properties
    if (turn.action == 'timeout') delete turn.action;
    if (turn.userTurnTime) delete turn.userTurnTime;
    if (turn.nextPlayer) delete turn.nextPlayer;
    if (turn.type) delete turn.type;

    // do turn in engine
    if (typeof this.engine.doTurn == "function") userTurn = this.engine.doTurn(room, user, turn, 'turn');
    else userTurn = turn;
    if (!userTurn || typeof userTurn != "object") { // wrong turn
        logger.err('GameManager.onUserTurn, wrong turn: ', userTurn, turn, 1);
        this.server.router.send({
            module: 'game_manager',
            type: 'error',
            target: user,
            data: 'wrong_turn'
        });
        return;
    }

    // switch player
    nextPlayer = this.switchPlayer(room, user, userTurn, 'turn');
    if (nextPlayer != game.current ) {  // if switch player
        if (room.timeout) clearTimeout(room.timeout);
        if (this.clearTimeouts) {
            room.data[game.current.userId].timeouts = 0;
        }
        userTurn.nextPlayer = nextPlayer.userId;
        room.game.turns++;
        room.askTakeBack = null;
        room.data[user.userId].userTurns++;
        if (room.data[user.userId].focusChanged){
            logger.err('GameManager.onUserTurn, turn after focus change ', user.userId, 3);
            room.data[user.userId].userUnfocusedTurns++;
            room.data[user.userId].focusChanged = false;
        }
    }
    room.savePlayerTurn(userTurn, nextPlayer);

    // send turn
    this.server.router.send({
        module: 'game_manager',
        type: 'turn',
        target:  room,
        data: {user:user.userId, turn:userTurn}
    });

    // send game event on user turn if need
    if (!isGameEnd && typeof this.engine.gameEvent == "function")
        this.sendEvent(room, this.engine.gameEvent(room, user, turn, false));
    // check endGame
    isGameEnd = this.checkGameEnd(room, user, turn, 'turn');

    // set current player and reset timeout
    if (!isGameEnd) {
        this.updateTime(room, nextPlayer);
    }
};


GameManager.prototype.updateTime = function(room, nextPlayer){
    var game = room.game;
    var userTurnTime = game.turnStartTime ? Date.now() - game.turnStartTime : 0;
    room.data[game.current.userId].userTotalTime += userTurnTime;
    if (nextPlayer != game.current && room.timeMode == 'dont_reset') {
        logger.log('GameManager.updateTime time:', userTurnTime, room.data[game.current.userId].userTotalTime, room.data[game.current.userId].userTurnTime, 3);
        room.data[game.current.userId].userTurnTime -= userTurnTime;
        // TODO: check if user time is out, time can be < 0
    }
    if (nextPlayer != game.current ||
            room.timeMode == 'reset_every_turn' ||
            (room.timeStartMode == 'after_turn' && !room.timeout) ||
            (room.timeStartMode == 'after_round_start' && !room.timeout) ||
            (room.timeMode == 'common' && !room.timeout)
        ){
        clearTimeout(room.timeout);
        if (nextPlayer != game.current){
            room.data[game.current.userId].userTurnTime += room.addTime;
        }
        room.game.current = nextPlayer;
        room.game.turnStartTime = Date.now();

        var turnTime = room.getTurnTime();
        if (turnTime > 1000 && (room.timeMode == 'reset_every_turn' || room.timeMode == 'reset_every_switch')) {
            turnTime += this.corTime;
        }

        logger.log('GameManager.updateTime timeout:', turnTime, this.corTime, room.getTurnTime(), 3);

        room.timeout = setTimeout(function () {
            this.onTimeout(room, room.game.current);
        }.bind(this),turnTime)
    }
};


GameManager.prototype.switchPlayer = function(room, user, turn, type){
    var nextPlayer;
    if (typeof this.engine.switchPlayer == "function") nextPlayer = this.engine.switchPlayer(room, user, turn, type);
    if (!nextPlayer) nextPlayer = this.defaultEngine.switchPlayer(room, user, turn, type);
    return nextPlayer;
};


GameManager.prototype.checkGameEnd = function(room, user, turn, type){
    var result = false; // false - game not end, null - draw, user - winner
    if (typeof this.engine.getGameResult == "function")
        result = this.engine.getGameResult(room, user, turn, type);
    else
        result = this.defaultEngine.getGameResult(room, user, turn, type);
    if (result) { // game end
        this.onRoundEnd(room, result);
        return true;
    }
    return false;
};


GameManager.prototype.onUserEvent = function(room, user, event){
    // check event type, throw, ask draw, ask moveback
    if (room.game.state != "playing") {
        logger.err('event in not started game room:', room.id, user.userId, 2);
        this.sendError(user, 'event in not started game room: ' + room.id);
        return;
    }
    if (!event.type) {
        logger.err('wrong event type ', room.id, user.userId, 1);
        this.sendError(user, 'wrong event type room: ' + room.id);
        return;
    }
    switch (event.type){
        case 'throw': this.onThrow(room, user, event.type); break;
        case 'draw': this.onDraw(room, user, event); break;
        case 'back': this.onTakeBack(room, user, event); break;
        case 'focus': this.onWindowFocus(room, user, event); break;
        default:
            logger.log('GameManager.onUserEvent', event.type, user.userId, 2);
            if (typeof this.engine.userEvent == "function"){
                this.sendEvent(room, this.engine.userEvent(room, user, event));
            }
            var isGameEnd = this.checkGameEnd(room, user, event, 'event');
    }
};


GameManager.prototype.sendEvent = function(room, data) {
    if (!data) return;

    if (data.length > 0) { // array of users and their events
        for (var i = 0; i < data.length; i++) {
            this.sendEvent(room, data[i], true);
        }
        return;
    }

    if (data.target) {
        if (!data.event || !data.event.type) {
            logger.warn('GameManager.sendEvent', 'wrong event', data, 1);
            return;
        }

        room.savePlayerEvent(data.target, data.event);

        this.server.router.send({
            module: 'game_manager',
            type: 'event',
            target: data.target,
            data: data.event
        });
    }
};


GameManager.prototype.onThrow = function(room, user, event){
    event = event || 'throw';
    for (var i = 0; i < room.players.length; i++)
        if (room.players[i] != user) {
            this.onRoundEnd(room, {
                winner: room.players[i],
                action: event
            });
            return;
        }
};


GameManager.prototype.onDraw = function(room, user, event){
    // TODO: check user can ask draw
    switch (event.action){
        case 'ask':
            if (!room.game.askDraw) {
                room.game.askDraw = user;
                this.server.router.send({
                    module: 'game_manager',
                    type: 'event',
                    target: room,
                    data: {
                        user: user.userId,
                        type: 'draw',
                        action: 'ask'
                    }
                });
            } else {
                if (room.game.askDraw == user) { // already asked
                    logger.log('GameManager.onDraw', 'user already ask draw', user.userId, 2);
                } else { // draw
                    logger.log('GameManager.onDraw', 'auto draw', user.userId, room.game.askDraw.userId, 2);
                    this.onRoundEnd(room, {action: 'draw'});
                }
            }
            break;
        case 'cancel':
            if (room.game.askDraw && room.game.askDraw != user) {
                this.server.router.send({
                    module: 'game_manager',
                    type: 'event',
                    target: room.game.askDraw,
                    data: {
                        user: user.userId,
                        type: 'draw',
                        action: 'cancel'
                    }
                });
                room.game.askDraw = null;
            } else {
                logger.warn('GameManager.onDraw', 'wrong cancel draw', user.userId, room.game.askDraw, 2);
            }
            break;
        case 'accept':
            if (room.game.askDraw && room.game.askDraw != user) {
                logger.log('GameManager.onDraw', 'draw', user.userId, room.game.askDraw.userId, 2);
                this.onRoundEnd(room, {action: 'draw'});
                room.game.askDraw = null;
            } else {
                logger.warn('GameManager.onDraw', 'wrong accept draw', user.userId, room.game.askDraw, 2);
            }
            break;
    }

};


GameManager.prototype.onTakeBack = function(room, user, event){
    switch (event.action) {
        case 'take':
            if (room.askTakeBack){ // send cancel to other user
                if (room.askTakeBack == user) {
                    return;
                } else {
                    this.server.router.send({
                        module: 'game_manager',
                        type: 'event',
                        target: room.askTakeBack,
                        data: {type: 'back', action: 'cancel', user: user.userId}
                    });
                    room.askTakeBack = null;
                }
            }
            if (room.data[user.userId].takeBacks < room.takeBacks){ // doTakeBack
                this.doTakeBack(room, user);
            } else { // ask
                room.askTakeBack = user;
                this.server.router.send({
                    module: 'game_manager',
                    type: 'event',
                    target: room.id,
                    data: {type: 'back', action: 'ask', user: user.userId}
                });
            }
            break;
        case 'accept':
            if (room.askTakeBack && room.askTakeBack != user)
                this.doTakeBack(room, room.askTakeBack);
            break;
        case 'cancel':
            if (room.askTakeBack && room.askTakeBack != user)
                this.server.router.send({
                    module: 'game_manager',
                    type: 'event',
                    target: room.askTakeBack,
                    data: {type: 'back', action: 'cancel', user: user.userId}
                });
            this.askTakeBack = null;
            break;
    }
};


GameManager.prototype.doTakeBack = function(room, user) {
    var game = room.game;
    room.askTakeBack = null;
    if (game.history.length > 0 && game.turns > 0) {
        for (var i = game.history.length - 2; i >= 0; i--) { // find previous user turn
            var turn = game.history[i];
            if (turn.length > 0) turn = turn[turn.length - 1];
            if (turn.nextPlayer == user.userId) {
                break;
            }
            if (i == 0) i = -1;
        }
        var count = game.history.length - i - 1;
        if (i < 0) {  // user was first, cut all turns
            if (game.first == user) {
                count = game.turns;
            } else {
                count = 0;
            }
            i = game.history.length - count - 1;
        }
        logger.log('GameManager.onTakeBack; cut count:', count, ' total turns: ', game.turns, 'history length:', game.history.length, i, 3);
        logger.log('GameManager.onTakeBack; shistory', game.shistory, 3);
        if (count > 0) { // cut turns
            for (var j = 0; j < count; j++) {
                game.shistory = game.shistory.substring(0, game.shistory.lastIndexOf('@'))
            }
            logger.log('GameManager.onTakeBack; shistory', game.shistory, 3);
            game.history.splice(i + 1);
            game.turns -= count;

            this.updateTime(room, user);
            this.sendTakeBack(room, user);
        }
    }
};


GameManager.prototype.sendTakeBack = function(room, user){
    room.data[user.userId].takeBacks++;
    this.server.router.send({
        module: 'game_manager',
        type: 'event',
        target: room.id,
        data: {
            user: user.userId,
            history: room.game.shistory,
            type: 'back',
            action: 'take'
        }
    });
};


GameManager.prototype.onWindowFocus = function(room, user, event){
    switch (event.action){
        case 'lost':
            this.server.router.send({
                module: 'game_manager',
                type: 'event',
                target: room.id,
                data: {
                    user: user.userId,
                    type: 'focus',
                    action: 'lost'
                }
            });
            break;
        case 'has':
            room.data[user.userId].focusChanged = true;
            this.server.router.send({
                module: 'game_manager',
                type: 'event',
                target: room.id,
                data: {
                    user: user.userId,
                    type: 'focus',
                    action: 'has'
                }
            });
            break;
    }
};


GameManager.prototype.onTimeout = function(room, user){
    room.data[user.userId].timeouts++;
    clearTimeout(room.timeout);
    logger.log('GameManager.onTimeout;', room.id, user.userId, room.data[user.userId].timeouts, 2);
    if (!room.hasOnlinePlayer()){
        this.onThrow(room, user, 'timeout');
        return;
    }
    // player auto skip turn, switch players
    var nextPlayer, turn = {action: 'timeout'}, game = room.game, isGameEnd;
    if (typeof this.engine.doTurn == 'function'){
        turn = this.engine.doTurn(room, user, turn, 'timeout');
    } else {
        turn = this.defaultEngine.doTurn(room, user, turn, 'timeout');
    }

    if (turn) {
        nextPlayer = this.switchPlayer(room, user, turn, 'timeout');
        //save end send timeout turn
        if (turn.action == 'timeout' || turn.type) {
            turn.user = user.userId;
            if (!turn.type) turn.type = turn.action;
        } else {
            if (room.userTurnTime) {
                turn.userTurnTime = room.userTurnTime
            }
        }
        game.timeouts++;
        if (nextPlayer != game.current) {  // if switch player
            turn.nextPlayer = nextPlayer.userId;
            room.game.turns++;
            room.askTakeBack = null;
        }
        room.savePlayerTurn(turn, nextPlayer);
        if (turn.action == 'timeout' || turn.type) {  // send event
            this.server.router.send({
                module: 'game_manager',
                type: 'event',
                target: room,
                data: turn
            });
        } else { //send turn
            this.server.router.send({
                module: 'game_manager',
                type: 'turn',
                target: room,
                data: { user: user.userId, turn: turn }
            });
        }
    }
    // check end game
    isGameEnd = this.checkGameEnd(room, user, turn, 'timeout');
    // send game event on user turn if need
    if (!isGameEnd && typeof this.engine.gameEvent == "function")
        this.sendEvent(room, this.engine.gameEvent(room, user, turn, false));

    // game no ended? but offline user have max timeouts
    if (!isGameEnd && !user.isConnected && room.data[user.userId].timeouts == this.maxOfflineTimeouts){
        this.onThrow(room, user, 'timeout');
        return;
    }
    // switch player, set timeout
    if (!isGameEnd) {
        this.updateTime(room, nextPlayer);
    }
};


GameManager.prototype.onUserPause = function(room, user) {
    // если игрок текущий и игра идет, не пауза и не ожидание
    // ставим игру на паузу
};


GameManager.prototype.onUserSpectate = function(room, user){
    if (!this.server.conf.spectateEnable) return;
    if (this.getUserRoom(user, false)){
        logger.err('GameManager.onUserSpectate', 'user already in room ', user.currentRoom.id, 2);
        return;
    }
    room.spectators.push(user);
    user.enterRoom(room);
    // send user room data
    this.server.router.send({
        module: 'game_manager',
        type: 'spectate',
        target: user,
        data: room.getGameData()
    });

    this.server.router.send({
        module: 'game_manager',
        type: 'spectator_join',
        target: room,
        data: {
            user: user.userId,
            room: room.id
        }
    });
};


GameManager.prototype.onSpectatorLeave = function(room, user){
    logger.log('GameManager.onSpectatorLeave', user.userId, room.id, 3);
    for (var i = 0; i < room.spectators.length; i++){
        if (room.spectators[i].userId == user.userId) {
            room.spectators.splice(i, 1);
                try { // users can leave room and room will be closed before round spectate stop
                    this.server.router.send({
                        module: 'game_manager',
                        type: 'spectator_leave',
                        target: room,
                        data: {
                            user: user.userId,
                            room: room.id
                        }
                    });
                } catch (e) {
                    logger.err('GameManager.onSpectatorLeave, err:', e, 1);
                }
            user.leaveRoom();
            return;
        }
    }
};


GameManager.prototype.onUserLeave = function(room, user){
    logger.log('GameManager.onUserLeave', user.userId, room.id, 2);
    var i, result;
    // other user win if game start
    if (room.game.state == "playing")
    for (i = 0; i < room.players.length; i++)
        if (room.players[i] != user) {
           result =  {
                winner: room.players[i],
                action: 'user_leave'
            };
            break;
        }
    // TODO: warn! async closing room
    this.onRoundEnd(room, result, function(){
        if (room.hasOnlinePlayer() || room.spectators.length > 0) // check room isn't empty
            try { // users can leave room and room will be closed before round result send
                this.server.router.send({
                    module: 'game_manager',
                    type: 'user_leave',
                    target: room,
                    data: user.userId
                });
            } catch (e) {
                logger.err('GameManager.onUserLeave, err:', e, 1);
            }
        else {
            logger.warn('GameManager.onUserLeave, room:', room.id, 'no players online', 1);
        }

        logger.log('closeRoom', room.id, 3);
        for (i = 0; i < room.players.length; i++) room.players[i].leaveRoom();
        for (i = 0; i < room.spectators.length; i++) room.spectators[i].leaveRoom();
        this.server.storage.popRoom(room);

        this.server.router.send({
            module: 'server',
            type: 'end_game',
            target: this.server.game,
            data: {players:room.getPlayersId(), room:room.id}
        });
    }.bind(this));
};


GameManager.prototype.onRoundEnd = function(room, result, callback){
    if (room.game.state != "playing") {
        logger.log('GameManager.onRoundEnd, room:', room.id, 'not playing! on user leave', 2);
        if (callback) callback();
        return;
    }

    var self = this;
    if (room.timeout) clearTimeout(room.timeout);
    room.timeout = null;

    result.timeStart = room.game.timeStart;
    result.timeEnd = Date.now();
    result.time = result.timeEnd - result.timeStart;

    if (typeof this.engine.getUsersScores == "function") result = this.engine.getUsersScores(room, result);
    if (result.winner && result.winner.userId) {
        result.winner = result.winner.userId;
    }
    result.save = result.save != null ? result.save : room.game.turns - room.game.timeouts >= room.minTurns;
    result.action = result.action != null ? result.action : 'game_over';

    logger.log('GameManager.onRoundEnd, room:', room.id, 'winner:', result.winner,
            'action:', result.action, 'save: ', result.save,
            'saveHistory:', room.saveHistory, 'saveRating:', room.saveRating, room.turnTime!=this.turnTime?'turnTime: '+room.turnTime :'', 3);

    room.game.state = "waiting";

    if (result.save) {
        room.games++;
        logger.log('GameManager.onRoundEnd, result:', room.data[room.players[0].userId].userTotalTime, room.data[room.players[1].userId].userTotalTime, 3);
        if (result.action == 'game_over'){
            this.checkCheaters(room, result);
        }
        if (result.winner) room.data[result.winner].win++;
        this.server.ratingManager.computeNewRatings(room, result, function(){
            logger.log('GameManager ratings computed', 3);
            self.sendGameResult(room, result, callback);
        });
    } else {
        this.sendGameResult(room, result, callback);
    }
};


GameManager.prototype.checkCheaters = function(room, result) {
    if (!this.server.conf.minUnfocusedTurns || !result || !result.winner) return;
    var user, turns, unfocusedTurns;
    for (var i = 0; i < room.players.length; i++){
        if (room.players[i].userId == result.winner) {
            user = room.players[i];
            turns = room.data[user.userId].userTurns;
            unfocusedTurns = room.data[user.userId].userUnfocusedTurns;
            logger.log('GameManager.checkCheaters, cheaters:', user.userId, turns, unfocusedTurns, 3);
            if (unfocusedTurns >= this.server.conf.minUnfocusedTurns
                && unfocusedTurns > (turns - 1) * this.server.conf.minPerUnfocusedTurns) {
                logger.log('GameManager.checkCheaters, cheater:', user.userId, user.userName, room.game.turns, turns, unfocusedTurns, 1);
                user[room.mode].timeLastCheatGame = result.timeEnd;
                user[room.mode].cheatWins = user[room.mode].cheatWins ? user[room.mode].cheatWins + 1 : 1;
                this.server.sendUserInfo(user);
            }
            return;
        }
    }
};


GameManager.prototype.sendGameResult = function(room, result, callback){
    logger.log('GameManager.sendGameResult, room:', room.id, result.action, 3);
    result.score = room.getScore();
    result.ratings = {};
    result.saveHistory = room.saveHistory;
    result.saveRating = room.saveRating;

    var user, i;
    for (i = 0; i < room.players.length; i++){
        user = room.players[i];
        room.data[user.userId].ready = false;
        room.data[user.userId].timeouts = 0;
        room.data[user.userId].takeBacks = 0;
        result.ratings[user.userId] = user[room.mode];
    }

    this.saveGame(room, result);

    if (room.hasOnlinePlayer() || room.spectators.length > 0) // check room isn't empty
        try{ // users can leave room and room will be closed before round result send
            this.server.router.send({
                module: 'game_manager',
                type: 'round_end',
                target: room,
                data: result
            });
        } catch (e) {
            logger.err('GameManager.sendGameResult, err:', e, 1);
        }
    else {
        logger.warn('GameManager.sendGameResult, room:', room.id, 'no players online', 1);
    }

    if (callback) callback();
    for (i = 0; i < room.players.length; i++) {
        if (!room.players[i].isConnected && !room.players[i].isRemoved) this.server.onUserLeave(room.players[i]);
    }
};


GameManager.prototype.saveGame = function(room, result){
    if (!result.save || !room.saveHistory) return;
    var save = {}, game = room.game, userData = {};
    for (var key in result){
        if (result.hasOwnProperty(key) && ['score', 'ratings', 'save', 'saveHistory', 'saveRating'].indexOf(key) == -1){
            save[key] = result[key];
        }
    }
    save.roomId = room.id;
    save.mode = room.mode;
    save.history = game.shistory;
    save.players = game.initData.players;
    game.initData.players = undefined;
    game.initData.score = undefined;
    try{
        save.initData = JSON.stringify(game.initData);
    } catch (e){
        logger.err('GameManager.saveGame initData, error: ', e, 1);
        save.initData = 'error';
    }
    try{
        save.score = JSON.stringify(result.score);
    } catch (e){
        logger.err('GameManager.saveGame score, error: ', e, 1);
        save.score = 'error';
    }
    try{
        for (var i = 0; i < room.players.length; i++)
            userData[room.players[i].userId] = room.players[i].getInfo(room.mode);
        save.userData = JSON.stringify(userData);
    } catch (e){
        logger.err('GameManager.saveGame userData, error: ', e, 1);
        save.userData = 'error';
    }
    logger.log('GameManager.saveGame, save: ', save.roomId, 'time: ', Date.now() - save.timeEnd, 3);
    this.server.storage.pushGame(save);
};


GameManager.prototype.getUserRoom = function(user, notSpectator){
    notSpectator = notSpectator !== false; // true default
    if (!user.currentRoom) return null;
    if (!notSpectator) return user.currentRoom;
    if (user.currentRoom.players.indexOf(user) != -1) return user.currentRoom;
    else {
        logger.log('GameManager.getUserRoom', 'user spectate in', user.currentRoom.id, user.userId, 3);
        return null;
    }
};


GameManager.prototype.getSpectatorRoom = function (user){
    if (!user.currentRoom) return null;
    if (user.currentRoom.spectators.indexOf(user) != -1) return user.currentRoom;
    else {
        logger.err('GameManager.getSpectatorRoom', 'user not spectate in', user.currentRoom.id, user.userId, 1);
        return null;
    }
};


GameManager.prototype.sendError = function(user, error){
    this.server.router.send({
        module: 'game_manager',
        type: 'error',
        target:  user,
        data: error
    });
};


GameManager.prototype.generateRoomId = function(owner, type){
    //game format name: "game_type_userId_socketId_hh.mm.ss"
    var now = new Date();
    return this.server.game + "_" + type + "_" + owner.userId + "_" + owner.socket.id
        + "_" + now.getHours() + ":" + now.getMinutes() + ":" + now.getSeconds();
};