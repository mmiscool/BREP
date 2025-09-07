"use strict";

import { constraints } from "./constraintDefinitions.js";
import { distance, calculateAngle } from "./mathHelpersMod.js";

// === Constraint function table ===
const constraintFunctions = constraints.constraintFunctions;

// === Engine that performs numeric solving on a sketch snapshot ===
class ConstraintEngine {
    constructor(sketchJSON) {
        const sketch = JSON.parse(sketchJSON);
        this.points = sketch.points.map(p => new Point(p.id, p.x, p.y, p.fixed));
        this.geometries = sketch.geometries || [];
        this.constraints = sketch.constraints || [];
    }

    processConstraintsOfType(type) {
        const list = (type === "all")
            ? this.constraints
            : this.constraints.filter(c => c.type === type);

        for (const constraint of list) {
            constraint.status = "";
            const constraintValue = parseFloat(constraint.value);
            const points = constraint.points.map(id => this.points.find(p => p.id === id));
            const before = JSON.stringify(points);

            if (constraint.previousPointValues !== undefined &&
                constraint.previousPointValues === before &&
                constraint.status === "solved") continue;

            try {
                constraintFunctions[constraint.type](this, constraint, points, constraintValue);
            } catch (e) {
                // Keep solving other constraints; record the error on this constraint
                constraint.error = e?.message || String(e);
            }

            const after = JSON.stringify(points);
            if (before === after) {
                constraint.status = "solved";
                constraint.previousPointValues = after;
            }
        }
    }

    async tidyDecimalsOfPoints(decimalsPlaces = 4, resetFixed = true) {
        for (const p of this.points) {
            if (resetFixed) p.fixed = false;

            if (typeof p.x === "string") p.x = parseFloat(p.x);
            if (typeof p.y === "string") p.y = parseFloat(p.y);

            if (p.x === null || p.x === undefined || Number.isNaN(p.x)) p.x = 0;
            if (p.y === null || p.y === undefined || Number.isNaN(p.y)) p.y = 0;

            const k = Math.pow(10, decimalsPlaces);
            p.x = Math.round(p.x * k) / k;
            p.y = Math.round(p.y * k) / k;
        }
    }

    solve(iterations = 100) {
        const decimalsPlaces = 6;

        // Implied constraints for certain geometry types (e.g., arcs)
        this.geometries.forEach(g => {
            if (g.type === "arc") {
                // Insert a temporary equal-chord constraint between (0-1) and (0-2)
                const maxId =
                    Math.max(0, ...this.constraints.map(c => Number.isFinite(+c.id) ? +c.id : 0)) + 1;
                this.constraints.push({
                    id: maxId,
                    type: "⇌",
                    points: [g.points[0], g.points[1], g.points[0], g.points[2]],
                    temporary: true,
                    labelX: 0,
                    labelY: 0
                });
            }
        });

        this.tidyDecimalsOfPoints(decimalsPlaces, true);

        // Ground first, then everything
        this.processConstraintsOfType("⏚");
        this.processConstraintsOfType("all");

        const order = [
            "━", "│", "⏛", "⋯",
            "⟺", "⇌", "∠", "⟂", "∥",
            "⇌", "⟺", "⇌", "⟺" // repeated passes for convergence
        ];

        let prev = JSON.stringify(this.points);
        let converged = false;

        for (let i = 0; i < iterations; i++) {
            for (const t of order) {
                this.processConstraintsOfType(t);
                this.processConstraintsOfType("≡"); // keep coincident snapping frequently
                this.processConstraintsOfType("━");
                this.processConstraintsOfType("|");
                this.tidyDecimalsOfPoints(decimalsPlaces, false);
                this.processConstraintsOfType("━");
                this.processConstraintsOfType("|");
                this.tidyDecimalsOfPoints(decimalsPlaces, false);
            }

            const cur = JSON.stringify(this.points);
            if (cur === prev) {
                converged = true;
                break;
            }
            prev = cur;

            // Movement throttling
            const maxMove = 0.5;
            for (let j = 0; j < this.points.length; j++) {
                const p = this.points[j];
                const last = JSON.parse(prev)[j];
                const dx = p.x - last.x;
                const dy = p.y - last.y;
                const d = Math.hypot(dx, dy);
                if (d > maxMove) {
                    const s = maxMove / d;
                    p.x = last.x + dx * s;
                    p.y = last.y + dy * s;
                }
            }
        }

        // Return a new sketch object mirroring input structure
        const updatedSketch = {
            points: this.points.map(p => ({ id: p.id, x: p.x, y: p.y, fixed: p.fixed })),
            geometries: this.geometries,
            constraints: this.constraints.filter(c => !c.temporary) // drop temporaries
        };

        return JSON.parse(JSON.stringify(updatedSketch));
    }
}

class Point {
    constructor(id, x, y, fixed = false) {
        this.id = id;
        this.x = x;
        this.y = y;
        this.fixed = fixed;
    }
}

// === Public API class ===
export default class ConstraintSolver {
    /**
     * @param {Object} opts
     * @param {Object} [opts.sketch]  initial sketch {points, geometries, constraints}
     * @param {Function} [opts.notifyUser]  (message, type) => void
     * @param {Function} [opts.updateCanvas] () => void
     * @param {Function} [opts.getSelectionItems] () => Array<{type:"point"|"geometry", id:number}>
     * @param {Object}   [opts.appState] external state to mirror mode/type/requiredSelections
     */
    constructor(opts = {}) {
        this.hooks = {
            notifyUser: typeof opts.notifyUser === "function" ? opts.notifyUser : (m) => { /* no-op in headless */ },
            updateCanvas: typeof opts.updateCanvas === "function" ? opts.updateCanvas : () => { },
            getSelectionItems: typeof opts.getSelectionItems === "function" ? opts.getSelectionItems : () => []
        };

        this.appState = opts.appState || { mode: "", type: "", requiredSelections: 0 };

        this.sketchObject = opts.sketch ? sanitizeSketch(opts.sketch) : {
            points: [{ id: 0, x: 0, y: 0, fixed: true }],
            geometries: [],
            constraints: [{ id: 0, type: "⏚", points: [0] }]
        };
    }

    // ---------- Core solve ----------
    solveSketch(iterations = null) {
        const iters = iterations === "full"
            ? this.fullSolve()
            : (iterations == null ? this.defaultLoops() : iterations);

        const engine = new ConstraintEngine(JSON.stringify(this.sketchObject));
        const solved = engine.solve(iters);
        this.sketchObject = solved;
        return this.sketchObject;
    }

    defaultLoops() { return 500; }
    fullSolve() { return 500; }

    // ---------- Accessors ----------
    getPointById(id) {
        return this.sketchObject.points.find(p => p.id === parseInt(id));
    }

    // ---------- Edit operations (formerly exported functions) ----------
    removePointById(id) {
        id = parseInt(id);
        if (id === 0) return;

        this.sketchObject.points = this.sketchObject.points.filter(p => p.id !== id);

        // Remove geometries referencing the point
        this.sketchObject.geometries = this.sketchObject.geometries.filter(g => !g.points.includes(id));

        // Remove constraints referencing the point
        this.sketchObject.constraints = this.sketchObject.constraints.filter(c => !c.points.includes(id));
    }

    removeGeometryById(id) {
        id = parseInt(id);
        if (id === 0) return;

        this.sketchObject.geometries = this.sketchObject.geometries.filter(g => parseInt(g.id) !== id);

        // If any constraint stores geometryId, prune those as well
        this.sketchObject.constraints = this.sketchObject.constraints.filter(c => c.geometryId !== id);
    }

    removeConstraintById(id) {
        id = parseInt(id);
        this.sketchObject.constraints = this.sketchObject.constraints.filter(c => parseInt(c.id) !== id);
    }

    toggleConstruction() {
        const items = this.hooks.getSelectionItems();
        if (!items || items.length === 0) return;

        for (const item of items) {
            if (item.type === "geometry") {
                const g = this.sketchObject.geometries.find(x => x.id === parseInt(item.id));
                if (!g) continue;
                if (g.construction === undefined) g.construction = false;
                g.construction = !g.construction;
            }
        }
        this.hooks.updateCanvas(false);
    }

    geometryCreateLine() {
        this.appState.mode = "createGeometry";
        this.appState.type = "line";
        this.appState.requiredSelections = 2;
        this.createGeometry("line");
    }

    geometryCreateCircle() {
        this.appState.mode = "createGeometry";
        this.appState.type = "circle";
        this.appState.requiredSelections = 2;
        this.createGeometry("circle");
    }

    geometryCreateArc() {
        this.appState.mode = "createGeometry";
        this.appState.type = "arc";
        this.appState.requiredSelections = 3;
        this.createGeometry("arc");
    }

    createGeometry(type, points = []) {
        // Use selection if not provided
        if (points.length === 0) {
            const items = this.hooks.getSelectionItems();
            if (items && items.length > 0) {
                points = [];
                for (const it of items) {
                    if (it.type === "point") {
                        const p = this.sketchObject.points.find(x => x.id === parseInt(it.id));
                        if (p) points.push(p);
                    }
                }
            }
        }

        if (this.appState.requiredSelections && points.length !== this.appState.requiredSelections) {
            return false;
        }

        let pointIds;
        if (points.length > 0 && typeof points[0] === "object") {
            pointIds = points.map(p => p.id);
        } else {
            pointIds = points;
        }

        if (!pointIds || pointIds.length === 0) return false;

        const maxId = Math.max(0, ...this.sketchObject.geometries.map(geo => +geo.id || 0)) + 1;
        const newGeometry = {
            id: maxId,
            type,
            points: pointIds,
            construction: false
        };

        this.sketchObject.geometries.push(newGeometry);
        this.hooks.updateCanvas();
        this.appState.mode = "";
        this.appState.type = "";
        this.appState.requiredSelections = 0;
        return true;
    }

    createConstraint(type, currentlySelected = null) {
        const selected = [];
        let geometryType = null;

        const items = Array.isArray(currentlySelected) ? currentlySelected : this.hooks.getSelectionItems();

        for (const item of items) {
            if (item.type === "point") {
                const p = this.sketchObject.points.find(pp => pp.id === parseInt(item.id));
                if (p) selected.push(p);
            }
            if (item.type === "geometry") {
                const g = this.sketchObject.geometries.find(gg => gg.id === parseInt(item.id));
                if (!g) continue;
                for (const pid of g.points) {
                    const p = this.sketchObject.points.find(pp => pp.id === pid);
                    if (p) selected.push(p);
                }
                if (g.type === "arc") selected.pop(); // center + start; omit end for 3pt cases
                geometryType = g.type;
            }
        }

        if (selected.length === 0) return;

        const selectedPointIds = selected.map(p => parseInt(p.id));

        const newConstraint = {
            id: 0,
            type,
            points: selectedPointIds,
            labelX: 0,
            labelY: 0,
            displayStyle: "",
            value: null,
            valueNeedsSetup: true
        };

        if (selected.length === 1) {
            if (type === "⏚") return this.createAndPushNewConstraint(newConstraint);
        }

        if (selected.length === 2) {
            if (type === "━") return this.createAndPushNewConstraint(newConstraint);
            if (type === "│") return this.createAndPushNewConstraint(newConstraint);
            if (type === "≡") return this.createAndPushNewConstraint(newConstraint);

            if (type === "⟺") {
                if (geometryType === "arc" || geometryType === "circle") newConstraint.displayStyle = "radius";
                return this.createAndPushNewConstraint(newConstraint);
            }
        }

        if (selected.length === 3) {
            if (type === "⏛") return this.createAndPushNewConstraint(newConstraint);
            if (type === "⋯") {
                // If first selected is a point, reverse to match expected ordering
                if (items[0]?.type === "point") {
                    newConstraint.points = selectedPointIds.slice().reverse();
                }
                // Auto set angle value as current acute/obtuse difference
                let line1Angle = calculateAngle(selected[0], selected[1]);
                let line2Angle = calculateAngle(selected[1], selected[2]);
                line1Angle = (line1Angle + 180) % 360 - 180;
                line2Angle = (line2Angle + 180) % 360 - 180;
                let diff = line1Angle - line2Angle;
                diff = (diff + 360) % 360;
                newConstraint.value = diff;
                return this.createAndPushNewConstraint(newConstraint);
            }
            if (type === "⇌") return this.createAndPushNewConstraint(newConstraint);
        }

        if (selected.length === 4) {
            if (type === "⟂") {
                let line1AngleA = calculateAngle(selected[0], selected[1]);
                let line1AngleB = calculateAngle(selected[1], selected[0]);
                let line2Angle = calculateAngle(selected[2], selected[3]);

                line1AngleA = (line1AngleA + 180) % 360 - 180;
                line1AngleB = (line1AngleB + 180) % 360 - 180;
                line2Angle = (line2Angle + 180) % 360 - 180;

                let diffA = line1AngleA - line2Angle;
                let diffB = line1AngleB - line2Angle;

                // Choose orientation closer to 90°
                if (Math.abs(90 - diffA) > Math.abs(90 - diffB)) {
                    [newConstraint.points[0], newConstraint.points[1]] = [newConstraint.points[1], newConstraint.points[0]];
                }
                return this.createAndPushNewConstraint(newConstraint);
            }
            if (type === "∥") return this.createAndPushNewConstraint(newConstraint);
            if (type === "∠") {
                let line1Angle = calculateAngle(selected[0], selected[1]);
                let line2Angle = calculateAngle(selected[2], selected[3]);
                line1Angle = (line1Angle + 180) % 360 - 180;
                line2Angle = (line2Angle + 180) % 360 - 180;
                let diff = (line1Angle - line2Angle + 360) % 360;
                newConstraint.value = diff;
                return this.createAndPushNewConstraint(newConstraint);
            }
            if (type === "⇌") return this.createAndPushNewConstraint(newConstraint);
        }

        this.hooks.updateCanvas();
        this.hooks.notifyUser(
            `Invalid selection for constraint type ${type}\nwith ${selected.length} points.`,
            "warning"
        );
    }

    createAndPushNewConstraint(constraint) {
        const maxId = Math.max(0, ...this.sketchObject.constraints.map(c => +c.id || 0)) + 1;
        constraint.id = maxId;
        constraint.value = (constraint.value === null || constraint.value === undefined)
            ? null
            : parseFloat(Number(constraint.value).toFixed(4));

        this.sketchObject.constraints.push(constraint);
        this.sketchObject = this.solveSketch("full");

        this.hooks.updateCanvas();
        this.hooks.notifyUser("Constraint added", "info");
        return true;
    }

    // ---------- Coincident simplification & cleanup ----------
    simplifyCoincidentConstraints() {
        const data = this.sketchObject;
        const coincidentGroups = {};
        const pointToGroup = {};

        data.constraints.forEach(constraint => {
            if (constraint.type === "≡") {
                const [p1, p2] = constraint.points;
                if (!coincidentGroups[p1]) coincidentGroups[p1] = new Set();
                if (!coincidentGroups[p2]) coincidentGroups[p2] = new Set();
                coincidentGroups[p1].add(p2);
                coincidentGroups[p2].add(p1);
            }
        });

        // Merge overlapping groups
        for (const [point, group] of Object.entries(coincidentGroups)) {
            for (const other of group) {
                if (coincidentGroups[other]) {
                    for (const p of coincidentGroups[other]) {
                        group.add(p);
                        coincidentGroups[p] = group;
                    }
                }
            }
        }

        for (const [point, group] of Object.entries(coincidentGroups)) {
            const minId = Math.min(...Array.from(group));
            pointToGroup[point] = minId;
        }

        // Replace IDs in constraints and geometries
        data.constraints.forEach(c => {
            c.points = c.points.map(p => pointToGroup[p] || p);
        });
        data.geometries.forEach(g => {
            g.points = g.points.map(p => pointToGroup[p] || p);
        });

        this.discardUnusedPoints();

        // Remove degenerate coincident constraints (same point twice)
        data.constraints = data.constraints.filter(c => !(c.type === "≡" && c.points[0] === c.points[1]));

        return this.sketchObject;
    }

    discardUnusedPoints() {
        const data = this.sketchObject;
        const used = new Set();
        data.constraints.forEach(c => c.points.forEach(pid => used.add(pid)));
        data.geometries.forEach(g => g.points.forEach(pid => used.add(pid)));
        data.points = data.points.filter(p => used.has(p.id));
        return this.sketchObject;
    }
}

// ---------- Utilities ----------
function sanitizeSketch(sketch) {
    const s = {
        points: Array.isArray(sketch.points) ? sketch.points.map(p => ({
            id: +p.id, x: +p.x, y: +p.y, fixed: !!p.fixed
        })) : [],
        geometries: Array.isArray(sketch.geometries) ? sketch.geometries.slice() : [],
        constraints: Array.isArray(sketch.constraints) ? sketch.constraints.slice() : []
    };

    // Ensure at least an origin and ground if empty
    if (s.points.length === 0) s.points.push({ id: 0, x: 0, y: 0, fixed: true });
    if (!s.constraints.some(c => c.type === "⏚")) {
        s.constraints.push({ id: 0, type: "⏚", points: [0] });
    }
    return s;
}

// Named exports for convenience (optional for consumers)
// Consumers should primarily instantiate the default export (ConstraintSolver)
export { ConstraintEngine };
