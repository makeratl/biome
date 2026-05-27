// Turn flow and game state machine

import { CONFIG } from './config.js';

const PHASE = {
    SETUP: 'SETUP',
    PLAYER_1_TURN: 'PLAYER_1_TURN',
    PLAYER_2_TURN: 'PLAYER_2_TURN',
    SIMULATING: 'SIMULATING',
    ROUND_END: 'ROUND_END',
    GAME_OVER: 'GAME_OVER',
};

export class TurnManager {
    constructor(onPhaseChange) {
        this.phase = PHASE.SETUP;
        this.round = 0;
        this.totalRounds = CONFIG.GAME.TOTAL_ROUNDS;
        this.apPerTurn = CONFIG.GAME.AP_PER_TURN;
        this.onPhaseChange = onPhaseChange;

        this.players = {
            1: { ap: 0, actions: [] },
            2: { ap: 0, actions: [] },
        };
    }

    get currentPlayer() {
        if (this.phase === PHASE.PLAYER_1_TURN) return 1;
        if (this.phase === PHASE.PLAYER_2_TURN) return 2;
        return null;
    }

    get currentAP() {
        const p = this.currentPlayer;
        return p ? this.players[p].ap : 0;
    }

    startGame() {
        this.round = 1;
        this._beginRound();
    }

    _beginRound() {
        this.players[1].ap = this.apPerTurn;
        this.players[1].actions = [];
        this.players[2].ap = this.apPerTurn;
        this.players[2].actions = [];
        this._setPhase(PHASE.PLAYER_1_TURN);
    }

    // Attempt to spend AP for an action. Returns true if successful.
    spendAP(cost) {
        const p = this.currentPlayer;
        if (!p) return false;
        if (this.players[p].ap < cost) return false;
        this.players[p].ap -= cost;
        return true;
    }

    // Record an action for undo support
    recordAction(action) {
        const p = this.currentPlayer;
        if (p) this.players[p].actions.push(action);
    }

    // End current player's turn (debounced to prevent double-click skip)
    endTurn() {
        const now = Date.now();
        if (now - (this._lastEndTurn || 0) < 600) return;
        this._lastEndTurn = now;

        if (this.phase === PHASE.PLAYER_1_TURN) {
            this._setPhase(PHASE.PLAYER_2_TURN);
        } else if (this.phase === PHASE.PLAYER_2_TURN) {
            this._setPhase(PHASE.SIMULATING);
        }
    }

    // Called when simulation finishes
    simulationComplete() {
        if (this.round >= this.totalRounds) {
            this._setPhase(PHASE.GAME_OVER);
        } else {
            this._setPhase(PHASE.ROUND_END);
        }
    }

    // Advance to next round
    nextRound() {
        this.round++;
        this._beginRound();
    }

    _setPhase(phase) {
        this.phase = phase;
        if (this.onPhaseChange) {
            this.onPhaseChange(phase, this);
        }
    }

    isPlayerTurn() {
        return this.phase === PHASE.PLAYER_1_TURN || this.phase === PHASE.PLAYER_2_TURN;
    }

    canPlaceOrganism() {
        return this.isPlayerTurn();
    }
}

export { PHASE };
