function getByPath(obj, path) {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function parseValue(raw) {
  raw = raw.trim();
  if ((raw.startsWith("'") && raw.endsWith("'")) || 
      (raw.startsWith('"') && raw.endsWith('"'))) {
    return raw.slice(1, -1);
  }
  const num = Number(raw);
  if (!isNaN(num) && raw !== '') {
    return num;
  }
  return raw;
}

function evaluateGuard(guard, payload, context) {
  if (!guard || !guard.trim()) {
    return true;
  }

  const expr = guard.trim();
  
  const operators = ['==', '!=', '>=', '<=', '>', '<'];
  let matchedOp = null;
  let opIndex = -1;

  for (const op of operators) {
    const idx = expr.indexOf(op);
    if (idx !== -1 && (matchedOp === null || idx < opIndex)) {
      matchedOp = op;
      opIndex = idx;
    }
  }

  if (!matchedOp) {
    throw new Error('Invalid guard expression: ' + expr);
  }

  const leftPart = expr.substring(0, opIndex).trim();
  const rightPart = expr.substring(opIndex + matchedOp.length).trim();

  let leftValue;
  if (leftPart.startsWith('payload.')) {
    leftValue = getByPath(payload, leftPart.substring(8));
  } else if (leftPart.startsWith('context.')) {
    leftValue = getByPath(context, leftPart.substring(8));
  } else {
    leftValue = parseValue(leftPart);
  }

  let rightValue;
  if (rightPart.startsWith('payload.')) {
    rightValue = getByPath(payload, rightPart.substring(8));
  } else if (rightPart.startsWith('context.')) {
    rightValue = getByPath(context, rightPart.substring(8));
  } else {
    rightValue = parseValue(rightPart);
  }

  switch (matchedOp) {
    case '==':
      return leftValue == rightValue;
    case '!=':
      return leftValue != rightValue;
    case '>':
      return leftValue > rightValue;
    case '<':
      return leftValue < rightValue;
    case '>=':
      return leftValue >= rightValue;
    case '<=':
      return leftValue <= rightValue;
    default:
      return false;
  }
}

module.exports = { evaluateGuard };
