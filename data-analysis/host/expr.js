/** Whitelisted computed-field expressions: tokenizer, recursive-descent parser, and evaluator. No `eval`. */
import { AnalysisError } from './util.js'

const FUNCTIONS = {
  IF: { arity: 3 },
  ROUND: { arity: 2 },
  ABS: { arity: 1 },
  COALESCE: { arity: Infinity },
  YEAR: { arity: 1 },
  MONTH: { arity: 1 },
  DAY: { arity: 1 },
  DATE_TRUNC: { arity: 2 },
  CONCAT: { arity: Infinity },
  LOWER: { arity: 1 },
  UPPER: { arity: 1 },
  LENGTH: { arity: 1 },
}

const OPERATORS = ['>=', '<=', '!=', '=', '>', '<', '+', '-', '*', '/', '%', '(', ')', ',']
const IDENTIFIER = /[\p{L}\p{N}_]+/u

/**
 * Convert a stored date or datetime string to a Date in local time.
 * @param value - `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ss`.
 * @returns A Date, or null when the text is not a date.
 */
function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?/.exec(value)
  if (match === null) return null
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0))
}

/** Carries the character offset of a parse failure. */
class ExpressionError extends AnalysisError {
  /**
   * @param message - What is wrong.
   * @param position - 0-based character offset.
   */
  constructor(message, position) {
    super(`Expression error at character ${position + 1}: ${message}`, 'bad_expression')
    this.position = position
  }
}

/**
 * Split an expression into tokens.
 * @param source - Expression text.
 * @returns Tokens with kind, text, and offset.
 */
function tokenize(source) {
  const tokens = []
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === '[') {
      const close = source.indexOf(']', index)
      if (close < 0) throw new ExpressionError('missing closing "]"', index)
      tokens.push({ kind: 'field', text: source.slice(index + 1, close), position: index })
      index = close + 1
      continue
    }
    if (char === '"' || char === "'") {
      const close = source.indexOf(char, index + 1)
      if (close < 0) throw new ExpressionError('unterminated string', index)
      tokens.push({ kind: 'string', text: source.slice(index + 1, close), position: index })
      index = close + 1
      continue
    }
    if (/\d/.test(char) || (char === '.' && /\d/.test(source[index + 1] ?? ''))) {
      const match = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(source.slice(index))
      tokens.push({ kind: 'number', text: match[0], position: index })
      index += match[0].length
      continue
    }
    const operator = OPERATORS.find(candidate => source.startsWith(candidate, index))
    if (operator !== undefined) {
      tokens.push({ kind: 'operator', text: operator, position: index })
      index += operator.length
      continue
    }
    const identifier = IDENTIFIER.exec(source.slice(index))
    if (identifier !== null && identifier.index === 0) {
      const text = identifier[0]
      tokens.push({ kind: 'identifier', text, position: index })
      index += text.length
      continue
    }
    throw new ExpressionError(`unexpected character "${char}"`, index)
  }
  tokens.push({ kind: 'eof', text: '', position: source.length })
  return tokens
}

/**
 * Parse a computed-field expression into an AST.
 * @param source - Expression text.
 * @param columnNames - Known columns; identifiers outside this set are rejected.
 * @returns `{ ast, dependsOn }`.
 */
export function parseExpression(source, columnNames) {
  const tokens = tokenize(source)
  const known = new Set(columnNames)
  const dependsOn = new Set()
  let cursor = 0

  const peek = () => tokens[cursor]
  const next = () => tokens[cursor++]
  const expectOperator = text => {
    const token = peek()
    if (token.kind !== 'operator' || token.text !== text) {
      throw new ExpressionError(`expected "${text}" but found "${token.text || 'end of expression'}"`, token.position)
    }
    cursor += 1
  }

  const parsePrimary = () => {
    const token = next()
    if (token.kind === 'number') return { kind: 'literal', value: Number(token.text) }
    if (token.kind === 'string') return { kind: 'literal', value: token.text }
    if (token.kind === 'field') {
      dependsOn.add(token.text)
      if (!known.has(token.text)) {
        throw new ExpressionError(`unknown column "${token.text}"`, token.position)
      }
      return { kind: 'field', name: token.text }
    }
    if (token.kind === 'operator' && token.text === '(') {
      const inner = parseOr()
      expectOperator(')')
      return inner
    }
    if (token.kind === 'identifier') {
      const upper = token.text.toUpperCase()
      if (upper === 'TRUE') return { kind: 'literal', value: true }
      if (upper === 'FALSE') return { kind: 'literal', value: false }
      if (upper === 'NULL') return { kind: 'literal', value: null }
      if (upper === 'AND' || upper === 'OR' || upper === 'NOT') {
        throw new ExpressionError(`"${token.text}" cannot start an expression`, token.position)
      }
      const spec = FUNCTIONS[upper]
      if (spec === undefined) throw new ExpressionError(`unknown function "${token.text}"`, token.position)
      expectOperator('(')
      const args = []
      if (peek().kind === 'operator' && peek().text === ')') {
        next()
      } else {
        for (;;) {
          args.push(parseOr())
          if (peek().kind === 'operator' && peek().text === ',') {
            next()
            continue
          }
          expectOperator(')')
          break
        }
      }
      if (args.length < spec.arity || (spec.arity !== Infinity && args.length > spec.arity)) {
        throw new ExpressionError(
          `"${token.text}" takes ${spec.arity === Infinity ? 'at least 1' : spec.arity} argument(s), got ${args.length}`,
          token.position,
        )
      }
      return { kind: 'call', name: upper, args }
    }
    if (token.kind === 'identifier') throw new ExpressionError(`unexpected identifier "${token.text}"`, token.position)
    throw new ExpressionError(`expected a value but found "${token.text || 'end of expression'}"`, token.position)
  }

  const parseUnary = () => {
    const token = peek()
    if (token.kind === 'operator' && token.text === '-') {
      next()
      return { kind: 'negate', operand: parseUnary() }
    }
    return parsePrimary()
  }

  const parseMultiplicative = () => {
    let left = parseUnary()
    for (;;) {
      const token = peek()
      if (token.kind === 'operator' && ['*', '/', '%'].includes(token.text)) {
        next()
        left = { kind: 'binary', operator: token.text, left, right: parseUnary() }
        continue
      }
      return left
    }
  }

  const parseAdditive = () => {
    let left = parseMultiplicative()
    for (;;) {
      const token = peek()
      if (token.kind === 'operator' && ['+', '-'].includes(token.text)) {
        next()
        left = { kind: 'binary', operator: token.text, left, right: parseMultiplicative() }
        continue
      }
      return left
    }
  }

  const parseComparison = () => {
    const left = parseAdditive()
    const token = peek()
    if (token.kind === 'operator' && ['=', '!=', '>', '>=', '<', '<='].includes(token.text)) {
      next()
      return { kind: 'binary', operator: token.text, left, right: parseAdditive() }
    }
    return left
  }

  const parseNot = () => {
    const token = peek()
    if (token.kind === 'identifier' && token.text.toUpperCase() === 'NOT') {
      next()
      return { kind: 'not', operand: parseNot() }
    }
    return parseComparison()
  }

  const parseAnd = () => {
    let left = parseNot()
    for (;;) {
      const token = peek()
      if (token.kind === 'identifier' && token.text.toUpperCase() === 'AND') {
        next()
        left = { kind: 'and', left, right: parseNot() }
        continue
      }
      return left
    }
  }

  const parseOr = () => {
    let left = parseAnd()
    for (;;) {
      const token = peek()
      if (token.kind === 'identifier' && token.text.toUpperCase() === 'OR') {
        next()
        left = { kind: 'or', left, right: parseAnd() }
        continue
      }
      return left
    }
  }

  const ast = parseOr()
  const trailing = peek()
  if (trailing.kind !== 'eof') {
    throw new ExpressionError(`unexpected "${trailing.text}" after the expression`, trailing.position)
  }
  return { ast, dependsOn: [...dependsOn] }
}

/**
 * Interpret truthiness the way a spreadsheet would.
 * @param value - Evaluated value.
 * @returns Boolean interpretation.
 */
function truthy(value) {
  if (value === null || value === undefined) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  return value.length > 0
}

/**
 * Compare two evaluated values with a relational operator.
 * @param operator - One of `=`, `!=`, `>`, `>=`, `<`, `<=`.
 * @param left - Left value.
 * @param right - Right value.
 * @returns Comparison result; null when either side is null.
 */
function compare(operator, left, right) {
  if (left === null || right === null) {
    if (operator === '=') return left === right
    if (operator === '!=') return left !== right
    return null
  }
  if (typeof left === 'number' && typeof right === 'number') {
    if (operator === '=') return left === right
    if (operator === '!=') return left !== right
    if (operator === '>') return left > right
    if (operator === '>=') return left >= right
    if (operator === '<') return left < right
    return left <= right
  }
  const leftText = String(left)
  const rightText = String(right)
  if (operator === '=') return leftText === rightText
  if (operator === '!=') return leftText !== rightText
  if (operator === '>') return leftText > rightText
  if (operator === '>=') return leftText >= rightText
  if (operator === '<') return leftText < rightText
  return leftText <= rightText
}

const TRUNC_UNITS = new Set(['day', 'week', 'month', 'quarter', 'year'])

/**
 * Evaluate an AST node against a dataset row.
 * @param node - AST node.
 * @param row - Dataset record.
 * @returns The computed value.
 */
function evaluateNode(node, row) {
  switch (node.kind) {
    case 'literal':
      return node.value
    case 'field':
      return row[node.name] ?? null
    case 'negate': {
      const value = evaluateNode(node.operand, row)
      return typeof value === 'number' ? -value : null
    }
    case 'not':
      return !truthy(evaluateNode(node.operand, row))
    case 'and':
      return truthy(evaluateNode(node.left, row)) && truthy(evaluateNode(node.right, row))
    case 'or':
      return truthy(evaluateNode(node.left, row)) || truthy(evaluateNode(node.right, row))
    case 'binary': {
      const left = evaluateNode(node.left, row)
      if (node.operator === '+') {
        if (left === null) return null
        if (typeof left === 'string') {
          const right = evaluateNode(node.right, row)
          return right === null ? null : `${left}${right}`
        }
        const right = evaluateNode(node.right, row)
        return typeof right === 'number' ? left + right : null
      }
      const right = evaluateNode(node.right, row)
      if (node.operator === '=' || node.operator === '!=' || node.operator === '>' || node.operator === '>='
        || node.operator === '<' || node.operator === '<=') {
        return compare(node.operator, left, right)
      }
      if (typeof left !== 'number' || typeof right !== 'number') return null
      if (node.operator === '-') return left - right
      if (node.operator === '*') return left * right
      if (node.operator === '/') return right === 0 ? null : left / right
      if (node.operator === '%') return right === 0 ? null : left % right
      return null
    }
    case 'call':
      return evaluateCall(node, row)
    default:
      throw new AnalysisError(`Unsupported expression node "${node.kind}".`, 'bad_expression')
  }
}

/**
 * Evaluate a whitelisted function call.
 * @param node - Call AST node.
 * @param row - Dataset record.
 * @returns The function result.
 */
function evaluateCall(node, row) {
  const args = node.args.map(arg => evaluateNode(arg, row))
  switch (node.name) {
    case 'IF':
      return truthy(args[0]) ? args[1] : args[2]
    case 'ROUND': {
      const value = args[0]
      const digits = args[1] ?? 0
      if (typeof value !== 'number' || typeof digits !== 'number') return null
      const factor = 10 ** Math.trunc(digits)
      return Math.round(value * factor) / factor
    }
    case 'ABS':
      return typeof args[0] === 'number' ? Math.abs(args[0]) : null
    case 'COALESCE':
      return args.find(value => value !== null && value !== undefined) ?? null
    case 'YEAR': {
      const date = toDate(args[0])
      return date === null ? null : date.getFullYear()
    }
    case 'MONTH': {
      const date = toDate(args[0])
      return date === null ? null : date.getMonth() + 1
    }
    case 'DAY': {
      const date = toDate(args[0])
      return date === null ? null : date.getDate()
    }
    case 'DATE_TRUNC': {
      const unit = String(args[0] ?? '').toLowerCase()
      const date = toDate(args[1])
      if (date === null || !TRUNC_UNITS.has(unit)) return null
      const pad = value => String(value).padStart(2, '0')
      if (unit === 'day') return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      if (unit === 'week') {
        const monday = new Date(date)
        const day = monday.getDay() === 0 ? 7 : monday.getDay()
        monday.setDate(monday.getDate() - (day - 1))
        return `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`
      }
      if (unit === 'month') return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`
      if (unit === 'quarter') return `${date.getFullYear()}-Q${Math.floor(date.getMonth() / 3) + 1}`
      return `${date.getFullYear()}`
    }
    case 'CONCAT':
      return args.every(value => value !== null) ? args.map(value => String(value)).join('') : null
    case 'LOWER':
      return args[0] === null ? null : String(args[0]).toLowerCase()
    case 'UPPER':
      return args[0] === null ? null : String(args[0]).toUpperCase()
    case 'LENGTH':
      return args[0] === null ? null : String(args[0]).length
    default:
      throw new AnalysisError(`Unknown function "${node.name}".`, 'bad_expression')
  }
}

/**
 * Compile an expression for repeated row evaluation.
 * @param source - Expression text.
 * @param columnNames - Known columns.
 * @returns `{ evaluate, dependsOn }`.
 */
export function compileExpression(source, columnNames) {
  const { ast, dependsOn } = parseExpression(source, columnNames)
  return {
    dependsOn,
    /**
     * @param row - Dataset record.
     * @returns The computed value.
     */
    evaluate(row) {
      const value = evaluateNode(ast, row)
      return value === undefined ? null : value
    },
  }
}
