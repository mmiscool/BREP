"use strict";
import { calculateAngle, rotatePoint, coinToss, distance, roundToDecimals } from "./mathHelpersMod.js";
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
        }else{
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
        return;
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

    if (Math.abs(deltaRaw) < 30 * tolerance) {
        constraint.error = `Angle constraint not satisfied
            ${targetAngle} != ${currentAngle}
            ${Math.abs(deltaRaw)} < 
            ${tolerance * 30}
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
            coinToss() ? rotatePoint(p1, p2, rotationLine1) : rotatePoint(p2, p1, rotationLine1);
        }
    }

    if (line2Moving && rotationLine2) {
        if (p3.fixed) {
            rotatePoint(p3, p4, rotationLine2);
        } else if (p4.fixed) {
            rotatePoint(p4, p3, rotationLine2);
        } else {
            coinToss() ? rotatePoint(p3, p4, rotationLine2) : rotatePoint(p4, p3, rotationLine2);
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
    // Treat the first two points as the line definition and the third as the point to project.
    const [pointA, pointB, pointC] = points;

    // simplify the constraint if possible for vertical and horizontal lines
    if (participateInConstraint(solverObject, "━", [pointA, pointB])) return constraintFunctions["━"](solverObject, constraint, [pointA, pointC], 0);
    if (participateInConstraint(solverObject, "━", [pointA, pointC])) return constraintFunctions["━"](solverObject, constraint, [pointA, pointB], 0);
    if (participateInConstraint(solverObject, "━", [pointB, pointC])) return constraintFunctions["━"](solverObject, constraint, [pointB, pointA], 0);

    if (participateInConstraint(solverObject, "│", [pointA, pointB])) return constraintFunctions["│"](solverObject, constraint, [pointA, pointC], 0);
    if (participateInConstraint(solverObject, "│", [pointA, pointC])) return constraintFunctions["│"](solverObject, constraint, [pointA, pointB], 0);
    if (participateInConstraint(solverObject, "│", [pointB, pointC])) return constraintFunctions["│"](solverObject, constraint, [pointB, pointA], 0);





    // Check if all points are movable or if two points are movable
    const allPointsMovable = !pointA.fixed && !pointB.fixed && !pointC.fixed;
    const pointAFixed = pointA.fixed;
    const pointBFixed = pointB.fixed;
    const pointCFixed = pointC.fixed;

    // If all points are movable, decide a strategy to minimize overall movement.
    // This could be complex and depend on the specific requirements or desired behavior.
    if (allPointsMovable) {
        // One strategy is to adjust all points towards the line formed by their centroid and one of the points.
        adjustAllPointsTowardsCentroidLine(pointA, pointB, pointC);
    } else {
        // If only one point is movable
        if (!pointCFixed && pointAFixed && pointBFixed) {
            projectPointToLine(pointC, pointA, pointB);
        } else if (!pointBFixed && pointAFixed && pointCFixed) {
            projectPointToLine(pointB, pointA, pointC);
        } else if (!pointAFixed && pointBFixed && pointCFixed) {
            projectPointToLine(pointA, pointB, pointC);
        }
        // If two points are movable
        else {
            // For two movable points, move each point half the distance to their projection on the line formed by all three points
            if (!pointAFixed && !pointBFixed) {
                adjustTwoPoints(pointA, pointB, pointC);
            } else if (!pointAFixed && !pointCFixed) {
                adjustTwoPoints(pointA, pointC, pointB);
            } else if (!pointBFixed && !pointCFixed) {
                adjustTwoPoints(pointB, pointC, pointA);
            }
        }
    }
}).hints = {
    commandTooltip: "Point on Line Constraint",
    pointsRequired: 3,
};

function adjustAllPointsTowardsCentroidLine(pointA, pointB, pointC) {
    // Calculate centroid of the three points
    const centroidX = (pointA.x + pointB.x + pointC.x) / 3;
    const centroidY = (pointA.y + pointB.y + pointC.y) / 3;

    // Use one of the points (e.g., pointA) and centroid to define the line
    projectPointToLine(pointB, { x: centroidX, y: centroidY }, pointA);
    projectPointToLine(pointC, { x: centroidX, y: centroidY }, pointA);
    // Since pointA is part of the line definition, it does not move
}

function adjustTwoPoints(movablePoint1, movablePoint2, fixedPoint) {
    // Calculate the line direction using movablePoint1 and movablePoint2's midpoint and the fixedPoint
    const midpointX = (movablePoint1.x + movablePoint2.x) / 2;
    const midpointY = (movablePoint1.y + movablePoint2.y) / 2;

    // Project both movable points onto the line defined by their midpoint and the fixed point
    projectPointToLine(movablePoint1, { x: midpointX, y: midpointY }, fixedPoint);
    projectPointToLine(movablePoint2, { x: midpointX, y: midpointY }, fixedPoint);
}

function projectPointToLine(movablePoint, fixedPoint1, fixedPoint2) {
    // Function remains the same as previously defined
    let dirX = fixedPoint2.x - fixedPoint1.x;
    let dirY = fixedPoint2.y - fixedPoint1.y;
    const mag = Math.sqrt(dirX * dirX + dirY * dirY);
    dirX /= mag; // Normalize
    dirY /= mag;

    const vecX = movablePoint.x - fixedPoint1.x;
    const vecY = movablePoint.y - fixedPoint1.y;
    const dot = vecX * dirX + vecY * dirY;
    const projX = fixedPoint1.x + dot * dirX;
    const projY = fixedPoint1.y + dot * dirY;

    movablePoint.x = projX;
    movablePoint.y = projY;
}

// Midpoint constraint with distance maintenance
(constraintFunctions["⋯"] = function (solverObject, constraint, points, constraintValue) {
    // This constraint will center the third point (C) between the first two points (A and B),
    // adjust the positions of A and B around C, and try to maintain the distance between A and B.

    //gracefully change the name of the constraint to upgrade from old files.
    if (constraint.type === "⋱") constraint.type = "⋯";

    const [pointA, pointB, pointC] = points; // Destructure the points for easier access

    // Calculate the initial distances
    const distanceAB = roundToDecimals(Math.sqrt(Math.pow(pointB.x - pointA.x, 2) + Math.pow(pointB.y - pointA.y, 2)), 4);
    const distanceAC = roundToDecimals(Math.sqrt(Math.pow(pointC.x - pointA.x, 2) + Math.pow(pointC.y - pointA.y, 2)), 7);
    const distanceBC = roundToDecimals(Math.sqrt(Math.pow(pointC.x - pointB.x, 2) + Math.pow(pointC.y - pointB.y, 2)), 7);


    const theoredicalMidpoint = {
        x: (pointA.x + pointB.x) / 2,
        y: (pointA.y + pointB.y) / 2,
        //fixed: true,
    }

    const perfectMidPointDistance = (distance(theoredicalMidpoint, pointA) + distance(theoredicalMidpoint, pointB)) / 2;


    //tolerance = 0.00001;
    const midpointToPerfectMidpoint = distance(pointC, theoredicalMidpoint);
    //console.log(midpointToPerfectMidpoint , 5 * tolerance);

    if (midpointToPerfectMidpoint < tolerance * 20) {
        constraintFunctions["≡"](solverObject, {}, [pointC, theoredicalMidpoint], 0);

        return constraint.error = null;
    } else {
        //constraintFunctions["≡"](solverObject, {}, [pointC, theoredicalMidpoint], 0);
        constraintFunctions["⟺"](solverObject, {}, [pointC, theoredicalMidpoint], 0);
        //constraintFunctions["⏛"](solverObject, {}, [pointA, pointB, pointC], 0);
        constraintFunctions["⟺"](solverObject, {}, [pointA, pointC], perfectMidPointDistance);
        constraintFunctions["⟺"](solverObject, {}, [pointB, pointC], perfectMidPointDistance);
        constraintFunctions["⟺"](solverObject, {}, [pointA, pointB], distanceAB);

        //constraintFunctions["⏛"](solverObject, {}, [pointA, pointB, pointC], 0);

        // test if the constraint is currently satisfied
        if (Math.abs(distanceAC - distanceBC) > tolerance) {
            constraint.error = `Midpoint constraint not satisfied
            X ${pointC.x} != ${theoredicalMidpoint.x} or
            Y ${pointC.y} != ${theoredicalMidpoint.y}
            ${Math.abs(distanceAC - distanceBC)} < ${tolerance}
            Deviation from midpoint ${midpointToPerfectMidpoint}`;

        } else {
            constraint.error = `Midpoint constraint not satisfied
        Distance of endpoints to midpoint do not match
        ${distanceAC} != ${distanceBC}
        Deviation from midpoint ${midpointToPerfectMidpoint}`;;
        }


        //constraintFunctions["⟺"](solverObject, {}, [pointA, pointC], perfectMidPointDistance);
        //constraintFunctions["⟺"](solverObject, {}, [pointB, pointC], perfectMidPointDistance);

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




function lockPoints(points) {
    points.forEach(point => point.fixed = true);
}
