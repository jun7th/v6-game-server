module.exports = {
    /**
     * on round begin init something
     * @param room
     * @returns {{inviteData: (*|userData.inviteData|Room.inviteData)}}
     */
    initGame: function (room) {
        return {
            inviteData: room.inviteData
        }
    },

    /**
     * on round begin set's first player
     * @param room
     * @returns {{player: Object}}
     */
    setFirst: function (room) {
        if (!room.game.first) return room.owner;
        if (room.players[0] == room.game.first)
            return room.players[1];
        else
            return room.players[0];
    },

    /**
     * every turn do something and send this to all
     * @param room
     * @param user
     * @param turn
     * @returns {turn}
     */
    doTurn: function(room, user, turn){
        return turn;
    },

    /**
     * every user turn checks switch player to next
     * @param room
     * @param user
     * @param turn
     * @returns {*}
     */
    switchPlayer: function(room, user, turn){
        if (turn == 'timeout'){
            // this is user timeout
        }
        if (room.players[0] == user) return room.players[1];
        else return room.players[0];
    },

    /**
     * every user turn checks game result
     * @param room
     * @param user
     * @param turn
     * @returns {*} false - game not end, null - draw, {winner : user} - winner
     */
    getGameResult: function(room, user, turn){
        switch (turn.result){
            case 0: // win other player
                    for (var i = 0; i < room.players.length; i++){
                        if (room.players[i] != user) {
                            return {
                                winner: room.players[i]
                            };
                        }
                    }
                break;
            case 1: // win current player
                return {
                    winner: user
                };
                break;
            case 2: // draw
                return {
                    winner: null
                };
                break;
            default: // game isn't end
                return false;
        }
        throw new Error('can not compute winner! room:' + room.id + ' result: ' + turn.result);
    }
};