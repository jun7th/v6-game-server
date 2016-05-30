var EventEmitter = require('events').EventEmitter;
var util = require('util');
var logger = require('./logger.js');

module.exports = Router;

function Router(server){
    EventEmitter.call(this);

    var self = this;
    this.server = server;
    this.wss = server.wss;

    // bind events
    this.wss.on('connection', function(socket){
        logger.log('Router', "new socket_connection", socket.id, socket.cookie._userId, 3);

        socket.on('disconnect', function(reason){
            if (reason == 'timeout') {
                self.emit('socket_timeout', socket);
            } else {
                self.emit('socket_disconnected', socket);
            }
        });
        socket.on('message', function(message){
            self.onSocketMessage(this, message);
        });
        self.emit('socket_connection', socket);
    });

    this.server.on('user_login', function(user){
        self.send({
           module:"server", type: "user_login", sender:user, target:self.server.game, data:user.getInfo()
        });
    });
    this.server.on('user_relogin', function(user){
        self.send({
            module:"server", type: "user_relogin", sender:user, target:self.server.game, data:user.getInfo()
        });
    });
    this.server.on('user_leave', function(user){
        var userRoom = self.server.gameManager.getUserRoom(user, true);
        if (self.wss.rooms[self.server.game] && (!userRoom || !userRoom.isPlaying()))
            self.send({
                module:"server", type: "user_leave", target:self.server.game, data:user.userId
            });
    });
}

util.inherits(Router, EventEmitter);


Router.prototype.onSocketMessage = function(socket, message){
    if (typeof message.type != "string" || typeof message.module != "string" || !message.data || !message.target) {
        logger.warn('Router.onSocketMessage', 'wrong income message', message, 1);
        return;
    }
    if (message.type == 'login'){
        message.sender =  socket;
    } else {
        try {
            message.sender = this.server.getUserById(socket.id);
            if (!message.sender) { // something wrong, user not exists, but client send  message
                logger.warn('Router.onSocketMessage', 'user not exists userId: ', socket.userId, 'type:', message.type, socket.id, 1);
                var user = this.server.router.getUser(socket.userId); // check other socket connected
                if (user) {
                    logger.warn('Router.onSocketMessage', 'user other socket connected ', user.userId, user.socket.id, 1);
                }
                // close socket end send error
                this.send({
                    module:'server',
                    type:'error',
                    target: socket.id,
                    data:'send_message'
                });
                socket.close();
                return;
            }
        } catch (err){ // get user or log error
            logger.warn('Router.onSocketMessage', 'get user error ', err, 0);
            return;
        }
    }
    switch (message.module) {
        case 'invite_manager': this.server.inviteManager.onMessage(message, message.type); break;
        case 'game_manager': this.server.gameManager.onMessage(message, message.type); break;
        case 'chat_manager': this.server.chatManager.onMessage(message, message.type); break;
        case 'history_manager': this.server.historyManager.onMessage(message, message.type); break;
        case 'rating_manager': this.server.ratingManager.onMessage(message, message.type); break;
        case 'server': this.server.onMessage(message, message.type); break;
        case 'admin': this.server.adminManager.onMessage(message, message.type); break;
    }
};


Router.prototype.send = function(message){
    if (!message.type || !message.module || !message.data || !message.target) {
        logger.err('wrong sent message', message, 1);
        return;
    }

    logger.log("Router.send", message.module, message.type, 3);

    var target = message.target,
        sender = message.sender;
    delete message.sender;
    delete message.target;
    if ((target.id == this.server.game || target == this.server.game) && !this.wss.rooms[this.server.game]){
        logger.warn("Router.send", 'no users to receive',  message.module, message.type, 1);
        return;
    }
    switch (target.name){
        case '__Socket__':
            target.send(message);
            break;
        case '__User__':
            target.socket.send(message);
            break;
        case '__Room__':
            if (sender && sender.socket) sender.socket.in(target.id).send(message);
            else this.wss.in(target.id).broadcast(message);
            break;
        default:
            if (typeof target == "string") {
                if (sender && sender.socket) sender.socket.in(target).send(message);
                else this.wss.in(target).broadcast(message);
            } else throw new Error('wrong target! ' + target);
    }
};