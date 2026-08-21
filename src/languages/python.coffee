# Droplet Python mode
#
# Copyright (c) 2015 Anthony Bau
# MIT License

helper = require '../helper.coffee'
parser = require '../parser.coffee'
treewalk = require '../treewalk.coffee'

skulpt = require '../../vendor/skulpt'

PYTHON_KEYWORDS = [
  'and', 'as', 'assert', 'break', 'class', 'continue', 'def', 'del', 'elif',
  'debugger', 'else', 'except', 'exec', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
  'is', 'lambda', 'not', 'or', 'pass', 'print', 'raise', 'return', 'try',
  'while', 'with', 'yield'
]

# PARSER SECTION
parse = (context, text) ->
  transform skulpt.parser.parse('file.py', text, context), text.split('\n')

getBounds = (node, lines) ->
  bounds = {
    start: {
      line: (node.lineno ? 1) - 1
      column: node.col_offset ? 0
    }
  }
  if node.children? and node.children.length > 0
    if skulpt.tables.ParseTables.number2symbol[node.type] is 'suite'
      # Avoid including DEDENT in the indent.
      bounds.end = getBounds(node.children[node.children.length - 2], lines).end
    else
      bounds.end = getBounds(node.children[node.children.length - 1], lines).end
  else
    bounds.end = {
      line: (node.line_end ? node.lineno ? 1) - 1
      column: node.col_end ? node.col_offset ? 0
    }
  bounds

getFunctionName = (node) ->
  if node.type is 'trailer'
    siblingNode = node.parent?.children[0]?.children?[0]
  else if node.type is 'power' and node.children.some((child) -> child.type is 'trailer')
    siblingNode = node.children[0].children?[0]

  if siblingNode?.type in ['T_KEYWORD', 'T_NAME']
    return siblingNode.data.text

  getFunctionName(node.parent) if node.parent?

getArgNum = (node) ->
  if node.parent?
    if node.type is 'argument'
      index = node.parent.children.indexOf(node)
      return Math.floor(index / 2) if index > -1
    else if node.parent.children.length is 1
      return getArgNum(node.parent)
  null

getColor = (opts, node) ->
  if getArgNum(node) is null
    return opts.functions?[getFunctionName(node)]?.color ? null

transform = (node, lines, parent = null) ->
  type = skulpt.tables.ParseTables.number2symbol[node.type] ?
    skulpt.Tokenizer.tokenNames[node.type] ? node.type
  type = 'T_KEYWORD' if type is 'T_NAME' and node.value in PYTHON_KEYWORDS

  result = {
    type
    bounds: getBounds(node, lines)
    parent
    data: {text: node.value ? null}
  }
  result.children = if node.children?
    node.children.map((child) -> transform(child, lines, result))
  else
    []
  result

# CONFIG SECTION
RULES = {
  'suite': {type: 'indent', indentContext: 'small_stmt'}
  'stmt': 'parens'

  'file_input': 'skip'
  'parameters': 'skip'
  'compound_stmt': 'skip'
  'small_stmt': 'skip'
  'simple_stmt': 'skip'
  'trailer': 'skip'
  'arglist': 'skip'
  'testlist_comp': 'skip'
  'with_item': 'skip'
  'listmaker': 'skip'
  'list_for': 'skip'

  'T_NAME': 'socket'
  'T_NUMBER': 'socket'
  'T_STRING': 'socket'
}

COLOR_RULES = [
  ['term', 'value']
  ['funcdef', 'control']
  ['for_stmt', 'control']
  ['while_stmt', 'control']
  ['with_stmt', 'control']
  ['if_stmt', 'control']
  ['try_stmt', 'control']
  ['import_stmt', 'command']
  ['print_stmt', 'command']
  ['expr_stmt', 'command']
  ['pass_stmt', 'command']
  ['return_stmt', 'return']
  ['testlist', 'value']
  ['comparison', 'value']
  ['test', 'value']
  ['expr', 'value']
]

SHAPE_RULES = []

config = {RULES, COLOR_RULES, SHAPE_RULES, PAREN_RULES: {}}

config.COLOR_CALLBACK = getColor

config.SHOULD_SOCKET = (opts, node) ->
  node.data.text not in Object.keys(opts.functions ? {}) or getArgNum(node) isnt null

module.exports = parser.wrapParser treewalk.createTreewalkParser(parse, config)
