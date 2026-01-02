"use strict";
import { calculateAngle, rotatePoint, distance, roundToDecimals } from "./mathHelpersMod.js";
let tolerance = 0.00001;
const constraintFunctions = [];

const normalizeAngle = (angle) => ((angle % 360) + 360) % 360;
const shortestAngleDelta = (target, current) => {
    const delta = normalizeAngle(target - current);
    return (delta > 180) ? delta - 360 : delta;
};


(constraintFunctions["━"] = function (solverObject, constraint, points, constraintValue) {
    // Horizontal constraint
    // test if the points are already on the same horizontal line with a tolerance
    if (Math.abs(points[0].y - points[1].y) < tolerance) {
        constraint.error = null;
    } else {
        constraint.error = `Horizontal constraint not satisfied
        ${points[0].y} != ${points[1].y}`;
    }

    if (!points[0].fixed && !points[1].fixed) {
        const avgY = (points[0].y + points[1].y) / 2;
        points[0].y = avgY;
        points[1].y = avgY;
    } else if (!points[0].fixed) {
        points[0].y = points[1].y;
    } else if (!points[1].fixed) {
        points[1].y = points[0].y;
    }
}).hints = {
    commandTooltip: "Horizontal Constraint",
    pointsRequired: 2,
};



(constraintFunctions["│"] = function (solverObject, constraint, points, constraintValue) {
    // Vertical constraint
    // test if the points are already on the same vertical line with a tolerance
    if (Math.abs(points[0].x - points[1].x) < tolerance * 2) {
        constraint.error = null;
    } else {
        constraint.error = `Vertical constraint not satisfied
        ${points[0].x} != ${points[1].x}`;
    }

    if (!points[0].fixed && !points[1].fixed) {
        const avgX = (points[0].x + points[1].x) / 2;
        points[0].x = avgX;
        points[1].x = avgX;
    } else if (!points[0].fixed) {
        points[0].x = points[1].x;
    } else if (!points[1].fixed) {
        points[1].x = points[0].x;
    }
}).hints = {
    commandTooltip: "Vertical Constraint",
    pointsRequired: 2,
};


(constraintFunctions["⟺"] = function (solverObject, constraint, points, constraintValue) {
    // Distance constraint with movement limiting
    const [pointA, pointB] = points;
    let targetDistance = constraintValue;
    let dx = pointB.x - pointA.x;
    let dy = pointB.y - pointA.y;
    let currentDistance = distance(pointA, pointB);

    //console.log(constraintValue);

    if (isNaN(constraintValue) | constraintValue == undefined | constraintValue == null) {
        targetDistance = currentDistance;
        constraint.value = currentDistance;
    }



    let diff = roundToDecimals(Math.abs(targetDistance) - currentDistance, 4);
    //console.log(diff);
    if (Math.abs(diff) === 0) {
        constraint.error = null;
        return;
    } else {
        constraint.error = `Distance constraint not satisfied
        ${targetDistance} != ${currentDistance}`;

    }

    if (currentDistance === 0) {
        currentDistance = 1; // Avoid division by zero
        dx = 1;
        dy = 1;
    }

    const ratio = diff / currentDistance;

    let offsetX = dx * ratio * 0.5;
    let offsetY = dy * ratio * 0.5;

    const direction = targetDistance >= 0 ? 1 : -1;

    // Limiting the movement
    const maxMove = 1;
    const moveDistance = Math.sqrt(offsetX * offsetX + offsetY * offsetY) || tolerance;
    if (moveDistance > maxMove) {
        const scale = maxMove / moveDistance;
        offsetX *= scale;
        offsetY *= scale;
    }

    if (!pointA.fixed && !pointB.fixed) {
        pointA.x -= offsetX * direction;
        pointA.y -= offsetY * direction;
        pointB.x += offsetX * direction;
        pointB.y += offsetY * direction;
    } else if (!pointA.fixed) {
        pointA.x -= offsetX * 2 * direction;
        pointA.y -= offsetY * 2 * direction;
    } else if (!pointB.fixed) {
        pointB.x += offsetX * 2 * direction;
        pointB.y += offsetY * 2 * direction;
    } else {
        return constraint.error = `points ${pointA.id} and ${pointB.id} are both fixed`;
    }
    return;
}).hints = {
    commandTooltip: "Distance Constraint",
    pointsRequired: 2,
};




(constraintFunctions["⇌"] = function (solverObject, constraint, points, constraintValue) {
    // Equal Distance constraint
    const [pointA, pointB, pointC, pointD] = points;

    // check if either line has a distance constraint applied to it
    // if so, then the line is not moving
    let line1DistanceConstraint = solverObject.constraints.find(c => c.type === "⟺" && c.points.includes(pointA.id) && c.points.includes(pointB.id));
    let line2DistanceConstraint = solverObject.constraints.find(c => c.type === "⟺" && c.points.includes(pointC.id) && c.points.includes(pointD.id));

    let avgDistance = null;
    let line1moving = false;
    let line2moving = false;
    if (!(line1DistanceConstraint) && !(line2DistanceConstraint)) {
        // Calculate the current distances
        const distanceAB = Math.sqrt(Math.pow(pointB.x - pointA.x, 2) + Math.pow(pointB.y - pointA.y, 2));
        const distanceCD = Math.sqrt(Math.pow(pointD.x - pointC.x, 2) + Math.pow(pointD.y - pointC.y, 2));
        avgDistance = (distanceAB + distanceCD) / 2;
        line1moving = true;
        line2moving = true;
    } else if (line1DistanceConstraint && !line2DistanceConstraint) {
        avgDistance = line1DistanceConstraint.value;
        line2moving = true;
    } else if (line2DistanceConstraint && !line1DistanceConstraint) {
        avgDistance = line2DistanceConstraint.value;
        line1moving = true;
    } else if (line1DistanceConstraint && line2DistanceConstraint) {
        //console.log(constraint, "Both lines have a distance constraint applied to them")
        return constraint.error = "Both lines have a distance constraint applied to them";
    }


    if (line1moving) {
        let result1 = constraintFunctions["⟺"](solverObject, constraint, [pointA, pointB], avgDistance);
        if (result1) return result1;
    }

    if (line2moving) {
        let result2 = constraintFunctions["⟺"](solverObject, constraint, [pointC, pointD], avgDistance);
        if (result2) return result2;
    }

}).hints = {
    commandTooltip: "Equal Distance Constraint",
    pointsRequired: 4,
};

(constraintFunctions["∥"] = function (solverObject, constraint, points, constraintValue) {
    // Parallel constraint
    // check if either line has a vertical or horizontal constraint applied to it
    // if so simply apply the vertical or horizontal constraint to the other line
    let line1VerticalConstraint = solverObject.constraints.find(c => c.type === "│" && c.points.includes(points[0].id) && c.points.includes(points[1].id));
    let line1HorizontalConstraint = solverObject.constraints.find(c => c.type === "━" && c.points.includes(points[0].id) && c.points.includes(points[1].id));
    let line2VerticalConstraint = solverObject.constraints.find(c => c.type === "│" && c.points.includes(points[2].id) && c.points.includes(points[3].id));
    let line2HorizontalConstraint = solverObject.constraints.find(c => c.type === "━" && c.points.includes(points[2].id) && c.points.includes(points[3].id));

    if (line1VerticalConstraint) {
        if (line2VerticalConstraint) {
            return constraint.error = "Both lines have a vertical constraint applied to them";
        } else if (line2HorizontalConstraint) {
            return constraint.error = "One line has a vertical constraint and the other has a horizontal constraint";
        } else {
            let result = constraintFunctions["│"](solverObject, constraint, [points[2], points[3]], 0);
            if (result) return result;
        }
    } else if (line1HorizontalConstraint) {
        if (line2VerticalConstraint) {
            return constraint.error = "One line has a vertical constraint and the other has a horizontal constraint";
        } else if (line2HorizontalConstraint) {
            return constraint.error = "Both lines have a horizontal constraint applied to them";
        } else {
            let result = constraintFunctions["━"](solverObject, constraint, [points[2], points[3]], 0);
            if (result) return result;
        }
    } else if (line2VerticalConstraint) {
        let result = constraintFunctions["│"](solverObject, constraint, [points[0], points[1]], 0);
        if (result) return result;
    } else if (line2HorizontalConstraint) {
        let result = constraintFunctions["━"](solverObject, constraint, [points[0], points[1]], 0);
        if (result) return result;
    } else {
        // test angle between the lines

        let line1Angle = calculateAngle(points[0], points[1]);
        let line2Angle = calculateAngle(points[2], points[3]);

        let angleDifference = (line1Angle - line2Angle);
        angleDifference = (angleDifference + 360) % 360;



        let newSetAngle = 0;
        if (angleDifference > 90) newSetAngle = 180;
        if (angleDifference > 180) newSetAngle = 180;
        if (angleDifference > 270) newSetAngle = 360;

        //console.log(angleDifference, newSetAngle);
        return constraintFunctions["∠"](solverObject, constraint, points, newSetAngle)
    }
}).hints = {
    commandTooltip: "Parallel Constraint",
    pointsRequired: 4,
};


(constraintFunctions["⟂"] = function (solverObject, constraint, points, constraintValue) {
    // Perpendicular constraint
    // check if either line has a vertical or horizontal constraint applied to it
    // if so simply apply the vertical or horizontal constraint to the other line
    let line1VerticalConstraint = solverObject.constraints.find(c => c.type === "│" && c.points.includes(points[0].id) && c.points.includes(points[1].id));
    let line1HorizontalConstraint = solverObject.constraints.find(c => c.type === "━" && c.points.includes(points[0].id) && c.points.includes(points[1].id));
    let line2VerticalConstraint = solverObject.constraints.find(c => c.type === "│" && c.points.includes(points[2].id) && c.points.includes(points[3].id));
    let line2HorizontalConstraint = solverObject.constraints.find(c => c.type === "━" && c.points.includes(points[2].id) && c.points.includes(points[3].id));

    if (line1VerticalConstraint) {
        if (line2VerticalConstraint) {
            return constraint.error = "Both lines have a vertical constraint applied to them";
        } else if (line2HorizontalConstraint) {
            return constraint.error = "One line has a vertical constraint and the other has a horizontal constraint";
        } else {
            let result = constraintFunctions["━"](solverObject, constraint, [points[2], points[3]], 0);
            if (result) return result;
        }
    } else if (line1HorizontalConstraint) {
        if (line2VerticalConstraint) {
            return constraint.error = "One line has a vertical constraint and the other has a horizontal constraint";
        } else if (line2HorizontalConstraint) {
            return constraint.error = "Both lines have a horizontal constraint applied to them";
        } else {
            let result = constraintFunctions["│"](solverObject, constraint, [points[2], points[3]], 0);
            if (result) return result;
        }
    } else if (line2VerticalConstraint) {
        let result = constraintFunctions["━"](solverObject, constraint, [points[0], points[1]], 0);
        if (result) return result;
    } else if (line2HorizontalConstraint) {
        let result = constraintFunctions["│"](solverObject, constraint, [points[0], points[1]], 0);
        if (result) return result;
    } else {

        let p1, p2, p3, p4;

        [p1, p2, p3, p4] = points;

        let line1Angle = calculateAngle(p1, p2);
        let line2Angle = calculateAngle(p3, p4);
        let differenceBetweenAngles = line1Angle - line2Angle;

        differenceBetweenAngles = (differenceBetweenAngles + 360) % 360;

        let newTargetAngle;

        if (differenceBetweenAngles <= 180) {
            newTargetAngle = 90;
        } else {
            newTargetAngle = 270;
        }

        //console.log("current values", differenceBetweenAngles, newTargetAngle)

        return constraintFunctions["∠"](solverObject, constraint, points, newTargetAngle);
    }
}).hints = {
    commandTooltip: "Perpendicular Constraint",
    pointsRequired: 4,
};


(constraintFunctions["∠"] = function (solverObject, constraint, points, constraintValue) {
    // Angle constraint
    const [p1, p2, p3, p4] = points;

    const line1Angle = calculateAngle(p1, p2);
    const line2Angle = calculateAngle(p3, p4);
    const differenceBetweenAngles = line1Angle - line2Angle;

    if (constraint.value == null) {
        // Seed with the current measured angle (normalize into [0, 360))
        constraint.value = roundToDecimals(normalizeAngle(differenceBetweenAngles), 4);
        // return; // Don't return, allow solving to happen immediately (e.g. if constraintValue provided)
    } else if (constraint.value < 0) {
        constraint.value = Math.abs(constraint.value);
        constraint.points = [constraint.points[2], constraint.points[3], constraint.points[1], constraint.points[0]];
        return;
    } else if (constraint.value > 360) {
        constraint.value = normalizeAngle(constraint.value);
        return;
    }

    const currentAngle = normalizeAngle(differenceBetweenAngles);
    let desiredAngle = Number.isFinite(constraintValue) ? constraintValue : parseFloat(constraint.value);
    if (!Number.isFinite(desiredAngle)) desiredAngle = currentAngle;
    const targetAngle = normalizeAngle(desiredAngle);

    const deltaRaw = shortestAngleDelta(targetAngle, currentAngle);

    if (Math.abs(deltaRaw) < tolerance) {
        constraint.error = null;
        return;
    }

    if (Math.abs(deltaRaw) > tolerance) {
        constraint.error = `Angle constraint not satisfied
            ${targetAngle} != ${currentAngle}
            Diff: ${Math.abs(deltaRaw).toFixed(4)}
            `;
    } else {
        constraint.error = null;
    }

    let line1Moving = !(p1.fixed && p2.fixed);
    let line2Moving = !(p3.fixed && p4.fixed);

    // Lines that already have horizontal/vertical constraints should stay put here.
    if (participateInConstraint(solverObject, "━", [p1, p2])) line1Moving = false;
    if (participateInConstraint(solverObject, "━", [p3, p4])) line2Moving = false;
    if (participateInConstraint(solverObject, "│", [p1, p2])) line1Moving = false;
    if (participateInConstraint(solverObject, "│", [p3, p4])) line2Moving = false;

    if (!line1Moving && !line2Moving) return;

    const maxStep = 1.5;
    let delta = deltaRaw;
    if (Math.abs(delta) > maxStep) delta = Math.sign(delta) * maxStep;

    let rotationLine1 = 0;
    let rotationLine2 = 0;

    if (line1Moving && line2Moving) {
        rotationLine1 = delta / 2;
        rotationLine2 = -delta / 2;
    } else if (line1Moving) {
        rotationLine1 = delta;
    } else if (line2Moving) {
        rotationLine2 = -delta;
    }

    if (line1Moving && rotationLine1) {
        if (p1.fixed) {
            rotatePoint(p1, p2, rotationLine1);
        } else if (p2.fixed) {
            rotatePoint(p2, p1, rotationLine1);
        } else {
            // Rotate around midpoint to decouple rotation from translation/length changes
            const midX = (p1.x + p2.x) / 2;
            const midY = (p1.y + p2.y) / 2;
            const center = { x: midX, y: midY };
            rotatePoint(center, p1, rotationLine1);
            rotatePoint(center, p2, rotationLine1);
        }
    }

    if (line2Moving && rotationLine2) {
        if (p3.fixed) {
            rotatePoint(p3, p4, rotationLine2);
        } else if (p4.fixed) {
            rotatePoint(p4, p3, rotationLine2);
        } else {
            // Rotate around midpoint
            const midX = (p3.x + p4.x) / 2;
            const midY = (p3.y + p4.y) / 2;
            const center = { x: midX, y: midY };
            rotatePoint(center, p3, rotationLine2);
            rotatePoint(center, p4, rotationLine2);
        }
    }

    return;
}).hints = {
    commandTooltip: "Angle Constraint",
    pointsRequired: 4,
};


(constraintFunctions["≡"] = function (solverObject, constraint, points, constraintValue) {
    // Coincident constraint
    const [point1, point2] = points;


    if (point1.fixed && point2.fixed) {
        if (participateInConstraint(solverObject, "⏚", [points[0]]) && participateInConstraint(solverObject, "⏚", [points[1]])) {
            constraint.error = "Both points are fixed";
        }
        return;
    }

    if (point1.x === point2.x && point1.y === point2.y) {
        // console.log("points are coincident");
        constraint.error = null;
    }
    else {
        if (!point1.fixed && !point2.fixed) {
            // If both points are not fixed, average their coordinates
            const avgX = (point1.x + point2.x) / 2;
            const avgY = (point1.y + point2.y) / 2;
            point1.x = avgX;
            point1.y = avgY;
            point2.x = avgX;
            point2.y = avgY;
        } else if (!point1.fixed) {
            point1.x = point2.x;
            point1.y = point2.y;
            point1.fixed = true;
        } else if (!point2.fixed) {
            point2.x = point1.x;
            point2.y = point1.y;
            point2.fixed = true;
        }

    }
    if (point1.fixed || point2.fixed) {
        point1.fixed = true;
        point2.fixed = true;
    }
}).hints = {
    commandTooltip: "Coincident Constraint",
    pointsRequired: 2,
};



(constraintFunctions["⏛"] = function (solverObject, constraint, points, constraintValue) {
    const [pointA, pointB, pointC] = points; // Line AB, Point C

    // Vector AB
    const dx = pointB.x - pointA.x;
    const dy = pointB.y - pointA.y;
    const lenSq = dx * dx + dy * dy;

    // Handle degenerate line case (A ~= B)
    if (lenSq < tolerance) {
        // Treat as coincident C to A
        const dist = distance(pointA, pointC);
        if (dist > tolerance) {
            constraint.error = `Point on Line: Line is degenerate (points too close) and Point C is not coincident.`;
            // Simple coincident push
            if (!pointC.fixed) {
                pointC.x = pointA.x;
                pointC.y = pointA.y;
            } else if (!pointA.fixed) {
                pointA.x = pointC.x;
                pointA.y = pointC.y;
                // Sync B to A since they are "coincident" in this check
                if (!pointB.fixed) {
                    pointB.x = pointC.x;
                    pointB.y = pointC.y
                }
            }
        } else {
            constraint.error = null;
        }
        return;
    }

    // Project C onto line AB
    // t = Dot(AC, AB) / |AB|^2
    const t = ((pointC.x - pointA.x) * dx + (pointC.y - pointA.y) * dy) / lenSq;

    // Closest Point on Line
    const projX = pointA.x + t * dx;
    const projY = pointA.y + t * dy;

    // Error Vector (C -> Proj)
    // We want C to be at Proj. So Error = C - Proj.
    const errX = pointC.x - projX;
    const errY = pointC.y - projY;
    const errDist = Math.sqrt(errX * errX + errY * errY);

    if (errDist < tolerance) {
        constraint.error = null;
        return;
    }

    constraint.error = `Point on Line not satisfied. Dist: ${errDist.toFixed(4)}`;

    // Gradients / Distribution
    // To minimize Error^2 = (Cx - Ax - t*dx)^2 + ...
    // Standard iterative geometric projection:
    // Move C towards Proj.
    // Move Line towards C.

    // Weighting:
    // If all movable, we distribute the move.
    // C moves by -Error.
    // A moves by +Error * (1-t).
    // B moves by +Error * t.
    // (This effectively rotates/moves the line based on the lever arm t)

    let wA = !pointA.fixed ? 1 : 0;
    let wB = !pointB.fixed ? 1 : 0;
    let wC = !pointC.fixed ? 1 : 0;

    // Normalize weights? 
    // Actually, we can just apply the delta directly with a damping/learning rate or just full Newton step geometry.
    // Geometric projection is usually stable with full steps if not conflicting.
    // However, since we have 3 points sharing the error correction:
    // If we move C full step, error is 0. If we move A/B full step, error is 0.
    // We should split it.

    // Simplified: Just assume roughly equal contribution capability?
    // Let's use specific "Position Based Dynamics" style constraints.
    // Inverse Masses: wA, wB, wC.
    // Jacobian J for C is N (normal). J for A is -(1-t)N. J for B is -tN.
    // Lambda = -Constraint / sum(w * J^2).
    // J^2 roughly 1 for C. (1-t)^2 for A. t^2 for B.

    let denom = 0;
    if (!pointC.fixed) denom += 1;
    if (!pointA.fixed) denom += (1 - t) * (1 - t);
    if (!pointB.fixed) denom += t * t;

    if (denom === 0) return; // All fixed

    // Relaxation factor (can use 1.0 for direct projection, but 0.8 helps stability)
    const k = 1.0;

    // Vector to correct error: (-errX, -errY)
    // C contributes: 1 * deltaC = -err
    // A contributes: -(1-t) * deltaA = -err
    // B contributes: -t * deltaB = -err

    // Common scalar lambda
    // We want sum(changes) to cancel error.
    // Actually, let's just use the direct formulas from PBD for Point-Segment distance.
    // corrC = - (w_c / sum) * error
    // corrA = + (w_a * (1-t) / sum) * error
    // corrB = + (w_a * t / sum) * error

    // In our case error vector E = (errX, errY) = C - Proj.
    // We want to displace points so C' becomes Proj'.

    const factor = k / denom;

    // Parallel expansion force (from analytical gradient of distance metric)
    // Helps avoid line collapse by encouraging length increase to reduce angular error.
    // Magnitude ~ Error / Length.
    // Only apply if we are moving the line points.
    let expansionX = 0;
    let expansionY = 0;
    if ((!pointA.fixed || !pointB.fixed) && lenSq > tolerance) {
        // Direction B-A
        const len = Math.sqrt(lenSq);
        const ux = dx / len;
        const uy = dy / len;

        // Force magnitude: errDist / len.
        // We dampen it slightly to avoid over-expansion instabilities.
        const expForce = (errDist / len) * 0.1 * factor;

        expansionX = ux * expForce;
        expansionY = uy * expForce;
    }

    if (!pointC.fixed) {
        pointC.x -= errX * factor;
        pointC.y -= errY * factor;
    }

    if (!pointA.fixed) {
        pointA.x += errX * (1 - t) * factor;
        pointA.y += errY * (1 - t) * factor;

        // Push A away from B (negative dir)
        pointA.x -= expansionX;
        pointA.y -= expansionY;
    }

    if (!pointB.fixed) {
        pointB.x += errX * t * factor;
        pointB.y += errY * t * factor;

        // Push B away from A (positive dir)
        pointB.x += expansionX;
        pointB.y += expansionY;
    }
}).hints = {
    commandTooltip: "Point on Line Constraint",
    pointsRequired: 3,
};

// Midpoint constraint with bidirectional update
(constraintFunctions["⋯"] = function (solverObject, constraint, points, constraintValue) {
    // Gracefully change the name of the constraint to upgrade from old files if needed
    if (constraint.type === "⋱") constraint.type = "⋯";

    const [pointA, pointB, pointC] = points; // C is the midpoint of A and B

    // Constraint equation: 2*C - A - B = 0
    // We treat this as a vector equation and project the error.

    // Calculate current residual (error)
    const rx = 2 * pointC.x - pointA.x - pointB.x;
    const ry = 2 * pointC.y - pointA.y - pointB.y;

    // Check satisfaction
    if (Math.abs(rx) < tolerance && Math.abs(ry) < tolerance) {
        constraint.error = null;
        return;
    }

    constraint.error = `Midpoint constraint not satisfied. Error: ${Math.hypot(rx, ry).toFixed(4)}`;

    // Gradients of internal function f = 2C - A - B
    // grad(C) = 2, grad(A) = -1, grad(B) = -1
    // We assume equal weights for "movability" but respect fixed status.

    let denom = 0;
    if (!pointA.fixed) denom += 1; // (-1)^2
    if (!pointB.fixed) denom += 1; // (-1)^2
    if (!pointC.fixed) denom += 4; // (2)^2

    if (denom === 0) {
        constraint.error = "All points fixed in Midpoint constraint";
        return;
    }

    // Lagrange multiplier step (Newton step for linear constraint)
    // alpha = - Error / sum(grad^2)
    const alphaX = -rx / denom;
    const alphaY = -ry / denom;

    // Update points
    // New Pos = Old Pos + alpha * grad
    if (!pointA.fixed) {
        pointA.x += alphaX * (-1);
        pointA.y += alphaY * (-1);
    }
    if (!pointB.fixed) {
        pointB.x += alphaX * (-1);
        pointB.y += alphaY * (-1);
    }
    if (!pointC.fixed) {
        pointC.x += alphaX * (2);
        pointC.y += alphaY * (2);
    }

}).hints = {
    commandTooltip: "Midpoint Constraint",
    pointsRequired: 3,
};

//gracefully change the name of the constraint
//constraintFunctions["⋱"] = constraintFunctions["⋯"];



(constraintFunctions["⏚"] = function (solverObject, constraint, points, constraintValue) {
    // Fixed constraint
    points[0].fixed = true;
}).hints = {
    commandTooltip: "Fix Point",
    pointsRequired: 1,
};


export const constraints = {
    tolerance,
    constraintFunctions,
}





function participateInConstraint(solverObject, constraintType, points) {
    return solverObject.constraints.some(c => {
        return c.type === constraintType && points.every(point => c.points.includes(point.id));
    });
}
