module.exports = {
    game: 'default',                // required, game name
    port: 8080,                     //
    pingTimeout:60000,             //
    pingInterval:10000,             //
    closeOldConnection: true,       //
    loseOnLeave: false,             // player lose game or not after leave
    reconnectOldGame: true,         // continue old game on reconnect or auto leave
    spectateEnable: true,           // on/off spectate games
    logLevel:4,                     // 0 - nothing, 1 - errors and warns, 2 - important, 3 and more - others
    turnTime: 100,                  // user turn time in seconds
    corTime: 1000,                     // additional time to turn on server
    timeMode: 'reset_every_switch', // time modes, ['reset_every_turn', 'reset_every_switch', 'dont_reset']
    timeStartMode: 'after_switch',  // start time, ['after_turn', 'after_switch', 'after_round_start']
    addTime: 0,                     // add time ms after user turn
    maxTimeouts: 1,                 // count user timeouts in game to lose
    clearTimeouts: true,            // reset user timeouts after turn
    maxOfflineTimeouts: 1,          // count offline user timeouts in game to lose
    minTurns: 0,                    // count switches players to save game
    takeBacks: 0,                   // count user take back
    ratingElo: true,                // compute rating elo flag
    calcDraw:  false,               // compute rating elo after draw
    loadRanksInRating: false,       // take user ranks in rating table from redis or not
    ratingUpdateInterval: 1000,     // how often update ranks in users array
    penalties: false,               // on/off rating penalties
    mode: 'debug',                  // set developing mode, 'develop', without db
    gameModes: ['default'],         // game modes, with different history, ratings, games, default is one mode ['default']
    modesAlias:{default:'default'}, // visible client mode alias
    adminList: [],
    adminPass: 'G@adm1n',
    enableIpGames: false,           // enable play games from one ip
    minUnfocusedTurns: 0,           // min count cheater tuns without focus
    minPerUnfocusedTurns: 0.9,      // min percent cheater tuns without focus
    mongo:{                 // mongodb configuration
        host: '127.0.0.1',
        port: '27017'
    },
    redis:{
        host: '127.0.0.1',
        port: '6379'
    }
};