const SIZE = 32;
const SQ3 = Math.sqrt(3);

class Hex {
    constructor(q, r, s) {
        this.q = q;
        this.r = r;
        this.s = s;
    }

    static fromQR(q, r) {
        return new Hex(q, r, -q - r);
    }

    add(other) {
        return new Hex(this.q + other.q, this.r + other.r, this.s + other.s);
    }

    rotateCW() {
        return new Hex(-this.r, -this.s, -this.q);
    }

    multiRotate(times) {
        let result = new Hex(this.q, this.r, this.s);
        const t = ((times % 6) + 6) % 6;
        for (let i = 0; i < t; i += 1) {
            result = result.rotateCW();
        }
        return result;
    }

    toString() {
        return `${this.q},${this.r},${this.s}`;
    }

    toPoint() {
        return {
            x: SIZE * SQ3 * (this.q + this.r / 2),
            y: SIZE * 1.5 * this.r,
        };
    }
}

const DIRS = [
    new Hex(1, -1, 0),
    new Hex(1, 0, -1),
    new Hex(0, 1, -1),
    new Hex(-1, 1, 0),
    new Hex(-1, 0, 1),
    new Hex(0, -1, 1),
];

const PIECE_TYPES = new Set(["PAWN", "ROOK", "KNIGHT", "BISHOP", "CARRIER", "PLANE"]);

const TYPE_COLOR = {
    PAWN: "var(--pawn)",
    ROOK: "var(--rook)",
    KNIGHT: "var(--knight)",
    BISHOP: "var(--bishop)",
    CARRIER: "var(--carrier)",
    PLANE: "var(--plane)",
};

const SIDE_STROKE = {
    A: "var(--player-a)",
    B: "var(--player-b)",
};

const EMPTY_SETUP = {
    currentPlayer: "A",
    phase: "attack",
    round: 1,
    pieces: [],
};

class Piece {
    constructor(cfg) {
        this.id = cfg.id;
        this.side = cfg.side;
        this.type = cfg.type;
        this.center = Hex.fromQR(cfg.q, cfg.r);
        this.dir = ((cfg.dir || 0) % 6 + 6) % 6;
        this.color = TYPE_COLOR[this.type] || "#cccccc";
        this.carrierId = cfg.carrierId || null;
        this.planeId = cfg.planeId || null;
        this.isOnCarrier = Boolean(cfg.isOnCarrier);
    }

    getDir(index) {
        return DIRS[((index % 6) + 6) % 6];
    }

    getOffsets() {
        const c = new Hex(0, 0, 0);
        const d = this.dir;
        switch (this.type) {
            case "PAWN":
            case "PLANE":
                return [c];
            case "ROOK":
                return [c, this.getDir(d)];
            case "KNIGHT":
                return [c, this.getDir(d), this.getDir(d + 1)];
            case "BISHOP":
                return [c, this.getDir(d), this.getDir(d + 1), this.getDir(d + 2)];
            case "CARRIER":
                return [c, this.getDir(d), this.getDir(d + 1), this.getDir(d + 2), this.getDir(d + 3)];
            default:
                return [c];
        }
    }

    getShape(customCenter) {
        const center = customCenter || this.center;
        return this.getOffsets().map((offset) => center.add(offset));
    }
}

class GameController {
    constructor(initialSetup) {
        this.grid = new Map();
        this.pieces = [];
        this.selected = null;
        this.currentPlayer = "A";
        this.phase = "attack";
        this.round = 1;
        this.deployMode = null;
        this.deploySide = "A";
        this.pendingTakeoffPlaneId = null;
        this.selectedMoved = false;
        this.movedThisPhase = new Set();
        this.idCounter = 1;
        this.undoStack = [];
        this.initBoard();
        this.loadSetup(initialSetup || window.INITIAL_STATE || EMPTY_SETUP);
        this.setupEvents();
        this.render();
        this.updateUI();
    }

    initBoard() {
        for (let r = -6; r <= 6; r += 1) {
            const width = 17 - Math.abs(r);
            const startQ = -Math.floor(width / 2) - Math.floor(r / 2);
            for (let i = 0; i < width; i += 1) {
                const h = Hex.fromQR(startQ + i, r);
                this.grid.set(h.toString(), h);
            }
        }
    }

    serializeGameState() {
        return {
            currentPlayer: this.currentPlayer,
            phase: this.phase,
            round: this.round,
            deployMode: this.deployMode,
            deploySide: this.deploySide,
            pendingTakeoffPlaneId: this.pendingTakeoffPlaneId,
            selectedId: this.selected ? this.selected.id : null,
            selectedMoved: this.selectedMoved,
            movedThisPhase: Array.from(this.movedThisPhase),
            idCounter: this.idCounter,
            pieces: this.pieces.map((p) => ({
                id: p.id,
                side: p.side,
                type: p.type,
                q: p.center.q,
                r: p.center.r,
                dir: p.dir,
                carrierId: p.carrierId || null,
                planeId: p.planeId || null,
                isOnCarrier: Boolean(p.isOnCarrier),
            })),
        };
    }

    restoreGameState(state) {
        this.currentPlayer = state.currentPlayer === "B" ? "B" : "A";
        this.phase = state.phase || "attack";
        this.round = Number.isInteger(state.round) ? state.round : 1;
        this.deployMode = state.deployMode || null;
        this.deploySide = state.deploySide === "B" ? "B" : "A";
        this.pendingTakeoffPlaneId = state.pendingTakeoffPlaneId || null;
        this.selectedMoved = Boolean(state.selectedMoved);
        this.movedThisPhase = new Set(Array.isArray(state.movedThisPhase) ? state.movedThisPhase : []);
        this.idCounter = Number.isInteger(state.idCounter) ? state.idCounter : this.idCounter;

        const pieces = Array.isArray(state.pieces) ? state.pieces : [];
        this.pieces = pieces
            .map((cfg) => this.normalizePieceConfig(cfg))
            .filter((cfg) => cfg && this.grid.has(Hex.fromQR(cfg.q, cfg.r).toString()))
            .map((cfg) => new Piece(cfg));

        this.syncCarrierPlaneRefs();
        this.selected = state.selectedId
            ? (this.pieces.find((p) => p.id === state.selectedId) || null)
            : null;
    }

    pushUndoState() {
        this.undoStack.push(this.serializeGameState());
        if (this.undoStack.length > 100) {
            this.undoStack.shift();
        }
    }

    undoLastAction() {
        if (this.undoStack.length === 0) {
            this.log("没有可撤销的操作");
            return;
        }
        const prev = this.undoStack.pop();
        this.restoreGameState(prev);
        this.log("已撤销上一步");
        this.render();
        this.updateUI();
    }

    log(message) {
        const box = document.getElementById("status-log");
        const line = document.createElement("div");
        line.textContent = `${new Date().toLocaleTimeString()} ${message}`;
        box.prepend(line);
    }

    getEnemySide(side) {
        return side === "A" ? "B" : "A";
    }

    getAllBySide(side) {
        return this.pieces.filter((p) => p.side === side);
    }

    genId(side, type) {
        const suffix = this.idCounter;
        this.idCounter += 1;
        return `${side}-${type}-${suffix}`;
    }

    normalizePieceConfig(cfg) {
        const side = cfg.side === "B" ? "B" : "A";
        const type = String(cfg.type || "").toUpperCase();
        const q = Number(cfg.q);
        const r = Number(cfg.r);
        if (!PIECE_TYPES.has(type)) return null;
        if (!Number.isInteger(q) || !Number.isInteger(r)) return null;
        return {
            id: cfg.id || this.genId(side, type),
            side,
            type,
            q,
            r,
            dir: Number.isInteger(cfg.dir) ? cfg.dir : 0,
            carrierId: cfg.carrierId || null,
            planeId: cfg.planeId || null,
            isOnCarrier: Boolean(cfg.isOnCarrier),
        };
    }

    loadSetup(setup) {
        this.pieces = [];
        this.selected = null;
        this.pendingTakeoffPlaneId = null;
        this.selectedMoved = false;
        this.movedThisPhase.clear();
        this.undoStack = [];
        this.currentPlayer = setup.currentPlayer === "B" ? "B" : "A";
        this.phase = setup.phase === "move" ? "move" : "attack";
        this.round = Number.isInteger(setup.round) ? setup.round : 1;
        const rawPieces = Array.isArray(setup.pieces) ? setup.pieces : [];

        for (const raw of rawPieces) {
            const cfg = this.normalizePieceConfig(raw);
            if (!cfg) continue;
            const piece = new Piece(cfg);
            if (this.grid.has(piece.center.toString())) {
                this.pieces.push(piece);
            }
        }

        for (const plane of this.pieces.filter((x) => x.type === "PLANE")) {
            if (!plane.carrierId) continue;
            const carrier = this.pieces.find((x) => x.id === plane.carrierId && x.type === "CARRIER" && x.side === plane.side);
            if (!carrier) continue;
            carrier.planeId = plane.id;
            if (plane.isOnCarrier) {
                plane.center = Hex.fromQR(carrier.center.q, carrier.center.r);
            }
        }

        this.removeInvalidOverlaps();
        this.log("初始布局已加载");
    }

    removeInvalidOverlaps() {
        const kept = [];
        for (const piece of this.pieces) {
            if (piece.type === "PLANE" && piece.isOnCarrier) {
                kept.push(piece);
                continue;
            }
            if (this.isAreaValid(piece.getShape(), piece, kept)) {
                kept.push(piece);
            }
        }
        this.pieces = kept;
        this.syncCarrierPlaneRefs();
    }

    syncCarrierPlaneRefs() {
        for (const carrier of this.pieces.filter((p) => p.type === "CARRIER")) {
            const plane = this.pieces.find((x) => x.type === "PLANE" && x.carrierId === carrier.id);
            carrier.planeId = plane ? plane.id : null;
        }
    }

    isAreaValid(shape, pieceToIgnore = null, occupiedPieces = this.pieces) {
        return shape.every((h) => {
            const key = h.toString();
            if (!this.grid.has(key)) return false;
            return !occupiedPieces.some((p) => {
                if (p === pieceToIgnore) return false;
                if (p.type === "PLANE" && p.isOnCarrier) return false;
                return p.getShape().some((ph) => ph.toString() === key);
            });
        });
    }

    getPieceAt(hex, includeOnCarrierPlane = false) {
        const key = hex.toString();
        return this.pieces.find((p) => {
            if (!includeOnCarrierPlane && p.type === "PLANE" && p.isOnCarrier) return false;
            return p.getShape().some((h) => h.toString() === key);
        }) || null;
    }

    buildOccupancyMap() {
        const map = new Map();
        for (const piece of this.pieces) {
            if (piece.type === "PLANE" && piece.isOnCarrier) continue;
            for (const h of piece.getShape()) {
                map.set(h.toString(), piece);
            }
        }
        return map;
    }

    getRayMoveCenters(piece, directionIndexes) {
        const result = [];
        for (const dirIdx of directionIndexes) {
            const vec = DIRS[((dirIdx % 6) + 6) % 6];
            let i = 1;
            while (true) {
                const nextCenter = new Hex(
                    piece.center.q + vec.q * i,
                    piece.center.r + vec.r * i,
                    piece.center.s + vec.s * i
                );
                if (!this.grid.has(nextCenter.toString())) break;
                const nextShape = piece.getShape(nextCenter);
                if (!this.isAreaValid(nextShape, piece)) break;
                result.push(nextCenter);
                i += 1;
            }
        }
        return result;
    }

    calculateMoveCenters(piece) {
        if (!piece) return [];
        if (piece.type === "PLANE") return [];

        if (piece.type === "PAWN") {
            return DIRS.map((d) => piece.center.add(d)).filter((h) => this.isAreaValid(piece.getShape(h), piece));
        }

        if (piece.type === "CARRIER") {
            return DIRS.map((d) => piece.center.add(d)).filter((h) => this.isAreaValid(piece.getShape(h), piece));
        }

        if (piece.type === "ROOK") {
            return this.getRayMoveCenters(piece, [piece.dir]);
        }

        if (piece.type === "KNIGHT") {
            return this.getRayMoveCenters(piece, [piece.dir, piece.dir + 1]);
        }

        if (piece.type === "BISHOP") {
            return this.getRayMoveCenters(piece, [piece.dir, piece.dir + 1, piece.dir + 2]);
        }

        return [];
    }

    getPlaneLandingCells(plane) {
        if (!plane || plane.type !== "PLANE") return [];
        const cells = [];
        this.grid.forEach((hex) => {
            if (this.isAreaValid([hex], plane)) {
                cells.push(hex);
            }
        });
        return cells;
    }

    collectRayAttackCells(piece, directionIndexes, occupancyMap, selfBodySet = new Set()) {
        const result = [];
        for (const dirIdx of directionIndexes) {
            const vec = DIRS[((dirIdx % 6) + 6) % 6];
            let i = 1;
            while (true) {
                const h = new Hex(
                    piece.center.q + vec.q * i,
                    piece.center.r + vec.r * i,
                    piece.center.s + vec.s * i
                );
                const key = h.toString();
                if (!this.grid.has(key)) break;
                if (selfBodySet.has(key)) {
                    i += 1;
                    continue;
                }
                const blocker = occupancyMap.get(key);
                if (blocker) {
                    if (blocker.side !== piece.side) result.push(h);
                    break;
                }
                result.push(h);
                i += 1;
            }
        }
        return result;
    }

    calculateAttackCells(piece, occupancyMap = this.buildOccupancyMap()) {
        if (!piece) return [];
        if (piece.type === "PLANE" && piece.isOnCarrier) return [];

        if (piece.type === "PAWN" || piece.type === "PLANE") {
            return DIRS.map((d) => piece.center.add(d)).filter((h) => this.grid.has(h.toString()));
        }

        if (piece.type === "ROOK") {
            const selfBody = new Set(piece.getShape().map((h) => h.toString()));
            return this.collectRayAttackCells(piece, [piece.dir], occupancyMap, selfBody);
        }

        if (piece.type === "KNIGHT") {
            const selfBody = new Set(piece.getShape().map((h) => h.toString()));
            return this.collectRayAttackCells(piece, [piece.dir, piece.dir + 1], occupancyMap, selfBody);
        }

        if (piece.type === "BISHOP") {
            const selfBody = new Set(piece.getShape().map((h) => h.toString()));
            return this.collectRayAttackCells(piece, [piece.dir, piece.dir + 1, piece.dir + 2], occupancyMap, selfBody);
        }

        if (piece.type === "CARRIER") {
            const body = piece.getShape();
            const bodySet = new Set(body.map((h) => h.toString()));
            const ring = new Set();
            for (const occupied of body) {
                for (const d of DIRS) {
                    const n = occupied.add(d);
                    const key = n.toString();
                    if (this.grid.has(key) && !bodySet.has(key)) ring.add(key);
                }
            }
            return Array.from(ring).map((k) => {
                const [q, r] = k.split(",").map(Number);
                return Hex.fromQR(q, r);
            });
        }

        return [];
    }

    getThreatsAtHex(hex, bySide = null) {
        const key = hex.toString();
        const occupancy = this.buildOccupancyMap();
        return this.pieces.filter((piece) => {
            if (piece.type === "PLANE" && piece.isOnCarrier) return false;
            if (bySide && piece.side !== bySide) return false;
            const attacks = this.calculateAttackCells(piece, occupancy);
            return attacks.some((h) => h.toString() === key);
        });
    }

    getThreatsOnPiece(targetPiece, bySide = null) {
        if (!targetPiece) return [];
        const targetCells = new Set(targetPiece.getShape().map((h) => h.toString()));
        const occupancy = this.buildOccupancyMap();
        return this.pieces.filter((piece) => {
            if (piece.id === targetPiece.id) return false;
            if (piece.type === "PLANE" && piece.isOnCarrier) return false;
            if (bySide && piece.side !== bySide) return false;
            const attacks = this.calculateAttackCells(piece, occupancy);
            return attacks.some((h) => targetCells.has(h.toString()));
        });
    }

    executeAttackPhase() {
        if (this.phase !== "attack") {
            this.log("当前不是攻击阶段");
            return;
        }
        this.pushUndoState();

        const occupancy = this.buildOccupancyMap();
        const attackers = this.getAllBySide(this.currentPlayer).filter((p) => !(p.type === "PLANE" && p.isOnCarrier));
        const attackedCells = new Set();

        for (const attacker of attackers) {
            const cells = this.calculateAttackCells(attacker, occupancy);
            for (const h of cells) attackedCells.add(h.toString());
        }

        const enemySide = this.getEnemySide(this.currentPlayer);
        const hitTargets = [];

        for (const target of this.getAllBySide(enemySide)) {
            if (target.type === "PLANE" && target.isOnCarrier) continue;
            const hit = target.getShape().some((h) => attackedCells.has(h.toString()));
            if (hit) hitTargets.push(target.id);
        }

        if (hitTargets.length > 0) {
            this.removePiecesCascade(hitTargets);
            this.log(`${this.currentPlayer} 方攻击命中 ${hitTargets.length} 枚敌方单位`);
        } else {
            this.log(`${this.currentPlayer} 方攻击未命中`);
        }

        this.autoRecallCurrentPlayerPlane();
        this.phase = "move";
        this.selected = null;
        this.pendingTakeoffPlaneId = null;
        this.selectedMoved = false;
        this.movedThisPhase.clear();

        this.render();
        this.updateUI();
        this.checkVictory();
    }

    autoRecallCurrentPlayerPlane() {
        const planes = this.getAllBySide(this.currentPlayer).filter((p) => p.type === "PLANE" && !p.isOnCarrier);
        for (const plane of planes) {
            const carrier = this.pieces.find((x) => x.id === plane.carrierId && x.type === "CARRIER" && x.side === plane.side);
            if (!carrier) continue;
            plane.center = Hex.fromQR(carrier.center.q, carrier.center.r);
            plane.isOnCarrier = true;
            this.log(`${plane.id} 已自动召回`);
        }
    }

    endMovePhase() {
        if (this.phase !== "move") {
            this.log("当前不是移动阶段");
            return;
        }
        this.pushUndoState();
        this.selected = null;
        this.pendingTakeoffPlaneId = null;
        this.selectedMoved = false;
        this.movedThisPhase.clear();
        this.currentPlayer = this.getEnemySide(this.currentPlayer);
        this.phase = "attack";
        this.round += 1;
        this.log(`轮到 ${this.currentPlayer} 方攻击阶段`);
        this.render();
        this.updateUI();
        this.checkVictory();
    }

    removePiecesCascade(ids) {
        const removeSet = new Set(ids);
        for (const piece of this.pieces) {
            if (!removeSet.has(piece.id)) continue;
            if (piece.type === "CARRIER" && piece.planeId) removeSet.add(piece.planeId);
        }
        this.pieces = this.pieces.filter((p) => !removeSet.has(p.id));
        this.syncCarrierPlaneRefs();
        if (this.selected && removeSet.has(this.selected.id)) {
            this.selected = null;
            this.selectedMoved = false;
        }
    }

    canOperateSelected() {
        if (!this.selected) return false;
        if (this.phase !== "move") return false;
        if (this.selected.side !== this.currentPlayer) return false;
        if (this.movedThisPhase.has(this.selected.id)) return false;
        return true;
    }

    tryRotateSelected(step) {
        if (!this.canOperateSelected()) return;
        if (this.selectedMoved) {
            this.log("该棋子已完成移动，本阶段不可再旋转");
            return;
        }
        if (this.selected.type === "CARRIER" || this.selected.type === "PAWN" || this.selected.type === "PLANE") {
            this.log("该兵种不可旋转");
            return;
        }

        const before = this.selected.dir;
        const nextDir = (this.selected.dir + step + 6) % 6;
        this.selected.dir = nextDir;
        const valid = this.isAreaValid(this.selected.getShape(), this.selected);
        this.selected.dir = before;
        if (!valid) {
            this.log("旋转后会碰撞或越界，已撤销");
            return;
        }
        this.pushUndoState();
        this.selected.dir = nextDir;
        this.render();
        this.updateUI();
    }

    tryMoveSelected(targetHex) {
        if (!this.canOperateSelected()) return false;
        if (this.selected.type === "PLANE") {
            this.log("Plane cannot use normal move");
            return false;
        }

        const legalMoves = this.calculateMoveCenters(this.selected);
        const ok = legalMoves.some((h) => h.toString() === targetHex.toString());
        if (!ok) return false;

        this.pushUndoState();
        this.selected.center = Hex.fromQR(targetHex.q, targetHex.r);
        if (this.selected.type === "CARRIER" && this.selected.planeId) {
            const plane = this.pieces.find((p) => p.id === this.selected.planeId && p.type === "PLANE");
            if (plane && plane.isOnCarrier) {
                plane.center = Hex.fromQR(targetHex.q, targetHex.r);
            }
        }

        this.selectedMoved = true;
        this.movedThisPhase.add(this.selected.id);
        this.log(`${this.selected.id} moved`);
        this.render();
        this.updateUI();
        return true;
    }

    selectPiece(piece) {
        if (!piece) {
            this.selected = null;
            this.selectedMoved = false;
            this.render();
            this.updateUI();
            return;
        }
        if (this.phase === "move" && piece.side !== this.currentPlayer) {
            this.log("Only friendly pieces can be selected in move phase");
            return;
        }
        if (this.phase === "move" && this.movedThisPhase.has(piece.id)) {
            const onboardPlane = piece.type === "CARRIER"
                ? this.pieces.find((x) => x.id === piece.planeId && x.type === "PLANE" && x.isOnCarrier)
                : null;
            if (!onboardPlane) {
                this.log("This piece has already acted in this move phase");
                return;
            }
        }
        this.selected = piece;
        this.selectedMoved = false;
        this.render();
        this.updateUI();
    }

    deployAt(hex) {
        if (!this.deployMode) return;
        const type = this.deployMode;
        const id = this.genId(this.deploySide, type);
        const piece = new Piece({
            id,
            side: this.deploySide,
            type,
            q: hex.q,
            r: hex.r,
            dir: 0,
        });

        if (!this.isAreaValid(piece.getShape(), null)) {
            this.log("Invalid deploy cell: out of board or occupied");
            return;
        }

        this.pushUndoState();
        this.pieces.push(piece);
        if (type === "CARRIER") {
            const plane = new Piece({
                id: this.genId(this.deploySide, "PLANE"),
                side: this.deploySide,
                type: "PLANE",
                q: hex.q,
                r: hex.r,
                dir: 0,
                carrierId: piece.id,
                isOnCarrier: true,
            });
            piece.planeId = plane.id;
            this.pieces.push(plane);
        }
        this.log(`${piece.id} deployed`);
        this.render();
        this.updateUI();
    }

    removeSelectedPiece() {
        if (!this.selected) return;
        this.pushUndoState();
        const removeIds = [this.selected.id];
        if (this.selected.type === "CARRIER" && this.selected.planeId) {
            removeIds.push(this.selected.planeId);
        }
        this.removePiecesCascade(removeIds);
        this.log("Selected piece removed");
        this.render();
        this.updateUI();
    }

    takeoffSelectedCarrierPlane() {
        if (!this.selected || this.selected.type !== "CARRIER") return;
        if (this.phase !== "move") {
            this.log("Takeoff is available only in move phase");
            return;
        }
        if (this.selected.side !== this.currentPlayer) return;

        const plane = this.pieces.find((p) => p.id === this.selected.planeId && p.type === "PLANE");
        if (!plane || !plane.isOnCarrier) return;
        this.pushUndoState();
        plane.center = Hex.fromQR(this.selected.center.q, this.selected.center.r);
        this.pendingTakeoffPlaneId = plane.id;
        this.selectPiece(plane);
        this.log(`${plane.id} took off, choose an empty cell to land`);
    }

    recallSelectedPlane() {
        if (!this.selected || this.selected.type !== "PLANE") return;
        if (this.phase !== "move") return;
        if (this.selected.side !== this.currentPlayer) return;
        if (this.movedThisPhase.has(this.selected.id)) return;

        const carrier = this.pieces.find((p) => p.id === this.selected.carrierId && p.type === "CARRIER" && p.side === this.selected.side);
        if (!carrier) {
            this.log("Carrier not found, recall failed");
            return;
        }
        this.pushUndoState();
        this.selected.isOnCarrier = true;
        this.selected.center = Hex.fromQR(carrier.center.q, carrier.center.r);
        this.selectedMoved = true;
        this.movedThisPhase.add(this.selected.id);
        this.selectPiece(carrier);
        this.log("Plane recalled to carrier");
    }

    tryLandPendingPlane(targetHex) {
        if (!this.pendingTakeoffPlaneId) return false;
        const plane = this.pieces.find((p) => p.id === this.pendingTakeoffPlaneId && p.type === "PLANE");
        if (!plane) {
            this.pendingTakeoffPlaneId = null;
            return false;
        }
        if (!this.isAreaValid([targetHex], plane)) {
            this.log("Landing cell is occupied or out of board");
            return true;
        }

        this.pushUndoState();
        plane.isOnCarrier = false;
        plane.center = Hex.fromQR(targetHex.q, targetHex.r);
        this.selected = plane;
        this.selectedMoved = true;
        this.movedThisPhase.add(plane.id);
        this.pendingTakeoffPlaneId = null;
        this.log(`${plane.id} landed`);
        this.render();
        this.updateUI();
        return true;
    }

    handleHexClick(hex) {
        if (this.deployMode) {
            this.deployAt(hex);
            return;
        }

        if (this.tryLandPendingPlane(hex)) {
            return;
        }

        if (this.phase === "move" && this.selected) {
            const moved = this.tryMoveSelected(hex);
            if (moved) return;
        }

        const clicked = this.getPieceAt(hex);
        this.selectPiece(clicked);
    }

    getHexPoints(hex) {
        const p = hex.toPoint();
        return [0, 1, 2, 3, 4, 5].map((i) => {
            const a = (Math.PI / 180) * (60 * i - 30);
            return `${p.x + SIZE * Math.cos(a)},${p.y + SIZE * Math.sin(a)}`;
        }).join(" ");
    }

    getOutlinePath(shape) {
        const valid = shape.filter((h) => this.grid.has(h.toString()));
        const edges = new Map();
        for (const h of valid) {
            const p = h.toPoint();
            const pts = [0, 1, 2, 3, 4, 5].map((i) => {
                const a = (Math.PI / 180) * (60 * i - 30);
                return {
                    x: (p.x + SIZE * Math.cos(a)).toFixed(2),
                    y: (p.y + SIZE * Math.sin(a)).toFixed(2),
                };
            });
            for (let i = 0; i < 6; i += 1) {
                const p1 = pts[i];
                const p2 = pts[(i + 1) % 6];
                const key = [p1.x, p1.y, p2.x, p2.y].sort().join("|");
                edges.set(key, (edges.get(key) || 0) + 1);
            }
        }

        let d = "";
        for (const h of valid) {
            const p = h.toPoint();
            const pts = [0, 1, 2, 3, 4, 5].map((i) => {
                const a = (Math.PI / 180) * (60 * i - 30);
                return {
                    x: (p.x + SIZE * Math.cos(a)).toFixed(2),
                    y: (p.y + SIZE * Math.sin(a)).toFixed(2),
                };
            });
            for (let i = 0; i < 6; i += 1) {
                const p1 = pts[i];
                const p2 = pts[(i + 1) % 6];
                const key = [p1.x, p1.y, p2.x, p2.y].sort().join("|");
                if (edges.get(key) === 1) {
                    d += `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y} `;
                }
            }
        }
        return d;
    }

    drawRange(hex, cls) {
        if (!this.grid.has(hex.toString())) return;
        const layerBottom = document.getElementById("layer-range");
        const layerTop = document.getElementById("layer-range-top");
        if (cls === "range-move") {
            const p = hex.toPoint();
            const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            ring.setAttribute("cx", p.x);
            ring.setAttribute("cy", p.y);
            ring.setAttribute("r", 10);
            ring.setAttribute("class", "move-marker-ring");
            layerTop.appendChild(ring);

            const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            dot.setAttribute("cx", p.x);
            dot.setAttribute("cy", p.y);
            dot.setAttribute("r", 2.8);
            dot.setAttribute("class", "move-marker-dot");
            layerTop.appendChild(dot);
            return;
        }

        const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
        poly.setAttribute("points", this.getHexPoints(hex));
        poly.setAttribute("class", cls);
        layerBottom.appendChild(poly);
    }

    renderGridIfNeeded() {
        const layer = document.getElementById("layer-grid");
        if (layer.innerHTML !== "") return;
        this.grid.forEach((h) => {
            const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
            poly.setAttribute("points", this.getHexPoints(h));
            poly.setAttribute("class", "hex");
            poly.onclick = () => this.handleHexClick(h);
            layer.appendChild(poly);

            const p = h.toPoint();
            const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
            text.setAttribute("x", p.x);
            text.setAttribute("y", p.y + 4);
            text.setAttribute("text-anchor", "middle");
            text.setAttribute("font-size", "9");
            text.setAttribute("fill", "#4a5d7a");
            text.setAttribute("pointer-events", "none");
            text.textContent = `${h.q},${h.r}`;
            layer.appendChild(text);
        });
    }

    renderRanges() {
        const layer = document.getElementById("layer-range");
        const layerTop = document.getElementById("layer-range-top");
        layer.innerHTML = "";
        layerTop.innerHTML = "";

        if (this.selected) {
            const occupancy = this.buildOccupancyMap();
            const moveCells = this.selected.type === "PLANE" && this.pendingTakeoffPlaneId === this.selected.id
                ? this.getPlaneLandingCells(this.selected)
                : this.calculateMoveCenters(this.selected);

            const attackCells = this.calculateAttackCells(this.selected, occupancy);
            const moveSet = new Set(moveCells.map((h) => h.toString()));
            const attackSet = new Set(attackCells.map((h) => h.toString()));
            const selfSet = new Set(this.selected.getShape().map((h) => h.toString()));
            for (const key of selfSet) {
                if (this.grid.has(key)) {
                    moveSet.add(key);
                }
            }

            for (const key of attackSet) {
                const [q, r] = key.split(",").map(Number);
                this.drawRange(Hex.fromQR(q, r), "range-attack");
            }

            for (const key of moveSet) {
                const [q, r] = key.split(",").map(Number);
                this.drawRange(Hex.fromQR(q, r), "range-move");
            }
            return;
        }

        if (this.phase === "attack") {
            const occupancy = this.buildOccupancyMap();
            const allAttack = new Set();
            for (const p of this.getAllBySide(this.currentPlayer)) {
                const cells = this.calculateAttackCells(p, occupancy);
                for (const cell of cells) allAttack.add(cell.toString());
            }
            for (const key of allAttack) {
                const [q, r] = key.split(",").map(Number);
                this.drawRange(Hex.fromQR(q, r), "range-attack");
            }
        }
    }

    renderPieces() {
        const layer = document.getElementById("layer-piece");
        layer.innerHTML = "";
        for (const piece of this.pieces) {
            if (piece.type === "PLANE" && piece.isOnCarrier) continue;
            const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
            for (const h of piece.getShape()) {
                if (!this.grid.has(h.toString())) continue;
                const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
                poly.setAttribute("points", this.getHexPoints(h));
                poly.setAttribute("fill", piece.color);
                poly.setAttribute("class", "piece-body");
                group.appendChild(poly);
            }

            const outline = document.createElementNS("http://www.w3.org/2000/svg", "path");
            outline.setAttribute("d", this.getOutlinePath(piece.getShape()));
            outline.setAttribute("class", "piece-shape");
            outline.setAttribute("stroke", this.selected && this.selected.id === piece.id ? "var(--accent)" : (SIDE_STROKE[piece.side] || "#fff"));
            if (this.selected && this.selected.id === piece.id) {
                outline.setAttribute("stroke-width", "4");
            }
            group.appendChild(outline);

            const cp = piece.center.toPoint();
            const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            dot.setAttribute("cx", cp.x);
            dot.setAttribute("cy", cp.y);
            dot.setAttribute("r", 4);
            dot.setAttribute("class", "main-dot");
            group.appendChild(dot);

            if (piece.type === "CARRIER" && piece.planeId) {
                const plane = this.pieces.find((p) => p.id === piece.planeId && p.type === "PLANE");
                if (plane && plane.isOnCarrier) {
                    const tri = document.createElementNS("http://www.w3.org/2000/svg", "path");
                    tri.setAttribute("d", `M ${cp.x} ${cp.y - 12} L ${cp.x - 10} ${cp.y + 6} L ${cp.x + 10} ${cp.y + 6} Z`);
                    tri.setAttribute("class", "carrier-status");
                    group.appendChild(tri);
                }
            }
            layer.appendChild(group);
        }
    }

    render() {
        this.renderGridIfNeeded();
        this.renderRanges();
        this.renderPieces();
    }

    updateThreatInfo() {
        const panel = document.getElementById("threat-info");
        if (!this.selected) {
            panel.textContent = "";
            return;
        }
        const enemySide = this.getEnemySide(this.selected.side);
        const threats = this.getThreatsOnPiece(this.selected, enemySide);
        if (threats.length === 0) {
            panel.textContent = "当前整枚棋子未被敌方攻击";
            return;
        }
        panel.textContent = `当前整枚棋子被攻击：${threats.map((p) => p.id).join(", ")}`;
    }

    updateUI() {
        document.getElementById("ui-player").textContent = `${this.currentPlayer} side`;
        let phaseText = "Move";
        if (this.phase === "attack") phaseText = "Attack";
        if (this.phase === "ended") phaseText = "Ended";
        document.getElementById("ui-phase").textContent = phaseText;
        document.getElementById("ui-round").textContent = String(this.round);

        const attackBtn = document.getElementById("btn-attack");
        const endMoveBtn = document.getElementById("btn-end-move");
        const undoBtn = document.getElementById("btn-undo");
        attackBtn.disabled = this.phase !== "attack";
        endMoveBtn.disabled = this.phase !== "move";
        if (undoBtn) {
            undoBtn.disabled = this.undoStack.length === 0;
        }

        const sideA = document.getElementById("deploy-side-a");
        const sideB = document.getElementById("deploy-side-b");
        sideA.classList.toggle("active", this.deploySide === "A");
        sideB.classList.toggle("active", this.deploySide === "B");

        document.querySelectorAll("#deploy-btns button[data-type]").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.type === this.deployMode);
        });

        const ops = document.getElementById("unit-ops");
        if (!this.selected) {
            ops.style.display = "none";
            return;
        }

        ops.style.display = "block";
        const pendingText = this.pendingTakeoffPlaneId === this.selected.id ? " - pending landing" : "";
        document.getElementById("sel-name").textContent = `${this.selected.id} (${this.selected.type})${pendingText}`;

        const takeoff = document.getElementById("btn-takeoff");
        const recall = document.getElementById("btn-recall");
        const del = document.getElementById("btn-del");
        const rotateCW = document.getElementById("btn-rotate-cw");
        const rotateCCW = document.getElementById("btn-rotate-ccw");

        const selectedPlane = this.selected.type === "CARRIER"
            ? this.pieces.find((x) => x.id === this.selected.planeId && x.type === "PLANE")
            : null;

        const canRotate = this.phase === "move"
            && this.selected.side === this.currentPlayer
            && !this.movedThisPhase.has(this.selected.id)
            && this.selected.type !== "CARRIER"
            && this.selected.type !== "PAWN"
            && this.selected.type !== "PLANE";

        if (rotateCW) rotateCW.disabled = !canRotate;
        if (rotateCCW) rotateCCW.disabled = !canRotate;

        takeoff.style.display = (
            this.phase === "move"
            && this.selected.type === "CARRIER"
            && this.selected.side === this.currentPlayer
            && selectedPlane
            && selectedPlane.isOnCarrier
        ) ? "block" : "none";

        recall.style.display = "none";

        del.style.display = "block";
        this.updateThreatInfo();
    }

    checkVictory() {
        const aliveA = this.getAllBySide("A").filter((p) => p.type !== "PLANE" || !p.isOnCarrier).length;
        const aliveB = this.getAllBySide("B").filter((p) => p.type !== "PLANE" || !p.isOnCarrier).length;
        if (aliveA === 0 || aliveB === 0) {
            const winner = aliveA > 0 ? "A" : "B";
            this.phase = "ended";
            this.selected = null;
            this.log(`Game over, ${winner} side wins`);
            this.render();
            this.updateUI();
        }
    }

    setupEvents() {
        document.getElementById("btn-attack").onclick = () => this.executeAttackPhase();
        document.getElementById("btn-end-move").onclick = () => this.endMovePhase();
        document.getElementById("btn-undo").onclick = () => this.undoLastAction();
        document.getElementById("btn-rotate-cw").onclick = () => this.tryRotateSelected(1);
        document.getElementById("btn-rotate-ccw").onclick = () => this.tryRotateSelected(-1);

        document.getElementById("deploy-side-a").onclick = () => {
            this.deploySide = "A";
            this.updateUI();
        };
        document.getElementById("deploy-side-b").onclick = () => {
            this.deploySide = "B";
            this.updateUI();
        };

        document.getElementById("deploy-btns").onclick = (e) => {
            const target = e.target;
            if (!(target instanceof HTMLElement)) return;
            const type = target.dataset.type;
            if (!type) return;
            this.deployMode = type;
            this.selected = null;
            this.render();
            this.updateUI();
        };

        document.getElementById("btn-deploy-cancel").onclick = () => {
            this.deployMode = null;
            this.updateUI();
        };

        document.getElementById("btn-del").onclick = () => this.removeSelectedPiece();
        document.getElementById("btn-takeoff").onclick = () => this.takeoffSelectedCarrierPlane();
        document.getElementById("btn-recall").onclick = () => this.recallSelectedPlane();

        window.onkeydown = (e) => {
            if (!this.selected) return;
            const key = e.key.toLowerCase();
            if (this.phase === "move" && key === "r") {
                this.tryRotateSelected(1);
            } else if (this.phase === "move" && key === "e") {
                this.tryRotateSelected(-1);
            } else if (key === "d") {
                this.removeSelectedPiece();
            }
        };
    }
}

function loadInitialSetupFromEmbedded() {
    const node = document.getElementById("initial-state");
    if (!node) {
        return EMPTY_SETUP;
    }
    try {
        const data = JSON.parse(node.textContent || "{}");
        if (Array.isArray(data.pieces)) {
            return data;
        }
    } catch (_) {
        // Fall through to empty setup.
    }
    return EMPTY_SETUP;
}

function bootstrapGame() {
    const setup = loadInitialSetupFromEmbedded();
    window.gameController = new GameController(setup);
}

window.applyInitialState = (state) => {
    if (!window.gameController) return;
    window.gameController.loadSetup(state || {});
    window.gameController.render();
    window.gameController.updateUI();
};

window.getThreatsAt = (q, r, side = null) => {
    if (!window.gameController) return [];
    const hex = Hex.fromQR(Number(q), Number(r));
    const threats = window.gameController.getThreatsAtHex(hex, side);
    return threats.map((p) => ({
        id: p.id,
        side: p.side,
        type: p.type,
        dir: p.dir,
    }));
};

bootstrapGame();
