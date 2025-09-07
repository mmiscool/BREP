export function getIntersectionPoint(point1, point2, point3, point4, offset = 0) {
  // Original Line 1 points
  let x1 = point1.x, y1 = point1.y;
  let x2 = point2.x, y2 = point2.y;

  // Original Line 2 points
  let x3 = point3.x, y3 = point3.y;
  let x4 = point4.x, y4 = point4.y;

  // Calculate direction vectors
  let dir1 = { x: x2 - x1, y: y2 - y1 };
  let dir2 = { x: x4 - x3, y: y4 - y3 };

  // Normalize direction vectors
  let mag1 = Math.sqrt(dir1.x * dir1.x + dir1.y * dir1.y);
  let mag2 = Math.sqrt(dir2.x * dir2.x + dir2.y * dir2.y);

  let unitDir1 = { x: dir1.x / mag1, y: dir1.y / mag1 };
  let unitDir2 = { x: dir2.x / mag2, y: dir2.y / mag2 };

  // Calculate offset points for Line 1
  let offsetPoint1 = { x: x1 + offset * unitDir1.y, y: y1 - offset * unitDir1.x };
  let offsetPoint2 = { x: x2 + offset * unitDir1.y, y: y2 - offset * unitDir1.x };

  // Calculate offset points for Line 2
  let offsetPoint3 = { x: x3 - offset * unitDir2.y, y: y3 + offset * unitDir2.x };
  let offsetPoint4 = { x: x4 - offset * unitDir2.y, y: y4 + offset * unitDir2.x };

  // Calculate line equations Ax + By = C for offset lines
  let A1 = offsetPoint2.y - offsetPoint1.y;
  let B1 = offsetPoint1.x - offsetPoint2.x;
  let C1 = A1 * offsetPoint1.x + B1 * offsetPoint1.y;

  let A2 = offsetPoint4.y - offsetPoint3.y;
  let B2 = offsetPoint3.x - offsetPoint4.x;
  let C2 = A2 * offsetPoint3.x + B2 * offsetPoint3.y;

  // Calculate intersection
  let det = A1 * B2 - A2 * B1;
  if (det === 0) {
    return null; // Lines are parallel
  } else {
    let x = (B2 * C1 - B1 * C2) / det;
    let y = (A1 * C2 - A2 * C1) / det;
    return { x, y };
  }
}






export function distance(point1, point2) {
  return Math.sqrt(Math.pow(point1.x - point2.x, 2) + Math.pow(point1.y - point2.y, 2));
}






export function polarToCartesian(centerX, centerY, radius, angleInDegrees) {
  const angleInRadians = angleInDegrees * Math.PI / 180.0;  // Removed the - 90
  return {
    x: centerX + (radius * Math.cos(angleInRadians)),
    y: centerY + (radius * Math.sin(angleInRadians))
  };
}


export function describeArc(x, y, radius, startAngle, endAngle) {
  if (startAngle === endAngle) {
    // Draw a full circle as two arcs (SVG doesn't allow a single arc to draw a full circle)
    return [
      "M", x + radius, y,
      "A", radius, radius, 0, 0, 1, x - radius, y,
      "A", radius, radius, 0, 0, 1, x + radius, y
    ].join(" ");
  } else {
    const start = polarToCartesian(x, y, radius, startAngle);
    const end = polarToCartesian(x, y, radius, endAngle);
    const largeArcFlag = ((endAngle - startAngle) + 360) % 360 <= 180 ? "0" : "1";
    const sweepFlag = "1"; // Always draw the arc in a "positive-angle" direction

    return [
      "M", start.x, start.y,
      "A", radius, radius, 0, largeArcFlag, sweepFlag, end.x, end.y
    ].join(" ");
  }
}

export function findMidpointOnArc(x, y, radius, startAngle, endAngle) {
  if (startAngle === endAngle) {
    // For a full circle, the midpoint is the center
    return { x: x, y: y };
  } else {
    const adjustedStartAngle = startAngle % 360;
    const adjustedEndAngle = endAngle % 360;
    let midpointAngle;

    if (adjustedStartAngle <= adjustedEndAngle) {
      midpointAngle = (adjustedStartAngle + adjustedEndAngle) / 2;
    } else {
      // Handle the case where the arc crosses the 0-degree line
      midpointAngle = ((adjustedStartAngle + adjustedEndAngle + 360) / 2) % 360;
    }

    return polarToCartesian(x, y, radius, midpointAngle);
  }
}
export function calculateAngle(point1, point2) {
  const dx = point2.x - point1.x;
  const dy = point2.y - point1.y;
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  return (angle + 360) % 360; // Normalize to [0, 360)
}

export function rotatePoint(center, point, angleDeg) {
  const angleRad = (angleDeg % 360) * (Math.PI / 180); // Normalize to [0, 360)
  const { x: x1, y: y1 } = center;
  const { x: x2, y: y2 } = point;
  const xRotated = (x2 - x1) * Math.cos(angleRad) - (y2 - y1) * Math.sin(angleRad) + x1;
  const yRotated = (x2 - x1) * Math.sin(angleRad) + (y2 - y1) * Math.cos(angleRad) + y1;
  point.x = xRotated;
  point.y = yRotated;
  return { x: xRotated, y: yRotated };
}



export function offsetLine(arrayOfPoints, distance) {
  // Extract the points from the array
  const [point1, point2] = arrayOfPoints;

  // Calculate the direction vector of the line
  const dx = point2.x - point1.x;
  const dy = point2.y - point1.y;

  // Normalize the direction vector
  const length = Math.sqrt(dx * dx + dy * dy);
  const dxNormalized = dx / length;
  const dyNormalized = dy / length;

  // Calculate the offset vector
  const dxOffset = dyNormalized * distance;
  const dyOffset = -dxNormalized * distance;

  // Create the new offset points
  const offsetPoint1 = { x: point1.x + dxOffset, y: point1.y + dyOffset };
  const offsetPoint2 = { x: point2.x + dxOffset, y: point2.y + dyOffset };

  // Return the new offset points in an array
  return [offsetPoint1, offsetPoint2];
}



export function coinToss() {
  return Math.random() < 0.5;
}


export function shuffle(array) {
  var currentIndex = array.length, temporaryValue, randomIndex;

  // While there remain elements to shuffle
  while (0 !== currentIndex) {

    // Pick a remaining element
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex -= 1;

    // And swap it with the current element
    temporaryValue = array[currentIndex];
    array[currentIndex] = array[randomIndex];
    array[randomIndex] = temporaryValue;

  }

  return array;
}


export function shuffleArray(originalArray) {
  // Creating a shallow copy of the original array
  const array = [...originalArray];
  for (let i = array.length - 1; i > 0; i--) {
    // Generate a random index lower than the current index
    const j = Math.floor(Math.random() * (i + 1));
    // Swap elements at indices i and j
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}


export function roundToDecimals(number, decimals) {
  return Math.round(number * Math.pow(10, decimals)) / Math.pow(10, decimals);
}



export function calcPerpendicularDistanceLineToPoint(linePoints, point) {
  const [pointA, pointB] = linePoints;

  // Calculate the direction vector of the line
  const dirX = pointB.x - pointA.x;
  const dirY = pointB.y - pointA.y;

  // Calculate the vector from pointA to the point
  const vecX = point.x - pointA.x;
  const vecY = point.y - pointA.y;

  // Calculate the projection of the point onto the line
  const t = (vecX * dirX + vecY * dirY) / (dirX * dirX + dirY * dirY);
  const projX = pointA.x + t * dirX;
  const projY = pointA.y + t * dirY;

  // Calculate the vector from the point to its projection on the line
  const perpX = projX - point.x;
  const perpY = projY - point.y;

  // Calculate the perpendicular distance
  const perpDistance = Math.sqrt(perpX * perpX + perpY * perpY);

  // Calculate the cross product to determine the side
  const crossProduct = dirX * vecY - dirY * vecX;

  // Use the sign of the cross product to set the sign of the distance
  const signedPerpDistance = crossProduct >= 0 ? perpDistance : -perpDistance;

  return signedPerpDistance * -1;
}


/// take an array of points and return the average point
export function averagePoint(points) {
  let x = 0;
  let y = 0;
  points.forEach(p => {
    x += p.x;
    y += p.y;
  });
  return { x: x / points.length, y: y / points.length };
}

// Function to calculate the intersection point of two lines
export function lineIntersection(line1, line2) {
  const [{ x: x1, y: y1 }, { x: x2, y: y2 }] = line1;
  const [{ x: x3, y: y3 }, { x: x4, y: y4 }] = line2;

  const det = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (det === 0) return null; // Lines are parallel

  const px = ((x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4)) / det;
  const py = ((x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4)) / det;

  return { x: px, y: py };
}

export function findArcIntersections(centerPoint, radius, line) {
  const [point1, point2] = line;
  
  // Check if the line is vertical (x1 === x2) or horizontal (y1 === y2)
  if (point1.x === point2.x) {
    // Vertical line, solve for x directly
    const x = point1.x;
    const y1 = centerPoint.y + Math.sqrt(radius * radius - (x - centerPoint.x) * (x - centerPoint.x));
    const y2 = centerPoint.y - Math.sqrt(radius * radius - (x - centerPoint.x) * (x - centerPoint.x));
    return [{ x, y: y1 }, { x, y: y2 }];
  } else if (point1.y === point2.y) {
    // Horizontal line, solve for y directly
    const y = point1.y;
    const x1 = centerPoint.x + Math.sqrt(radius * radius - (y - centerPoint.y) * (y - centerPoint.y));
    const x2 = centerPoint.x - Math.sqrt(radius * radius - (y - centerPoint.y) * (y - centerPoint.y));
    return [{ x: x1, y }, { x: x2, y }];
  }
  
  // For non-vertical and non-horizontal lines, continue with your existing code
  const m = (point2.y - point1.y) / (point2.x - point1.x);
  const b = point1.y - m * point1.x;
  
  const h = centerPoint.x;
  const k = centerPoint.y;
  
  const a = 1 + m * m;
  const b2 = 2 * (m * (b - k) - h);
  const c = h * h + (b - k) * (b - k) - radius * radius;
  
  const discriminant = b2 * b2 - 4 * a * c;
  
  if (discriminant < 0) {
    return [];  // No intersection
  }
  
  const x1 = (-b2 + Math.sqrt(discriminant)) / (2 * a);
  const x2 = (-b2 - Math.sqrt(discriminant)) / (2 * a);
  
  const y1 = m * x1 + b;
  const y2 = m * x2 + b;
  
  return [
    { x: x1, y: y1 },
    { x: x2, y: y2 }
  ];
}
