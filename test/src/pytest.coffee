Python = require '../../src/languages/python.coffee'

asyncTest 'Python 3 compatibility corpus round-trips through blocks', ->
  python = new Python({functions: {}})
  cases = [
    'total = 1 + 2.5\n'
    "label = 'hello'\n"
    'message = "hello"\n'
    'result = outer(inner(1))\n'
    'if total > 2:\n  print(total)\nelse:\n  print(0)\n'
    'for item in range(3):\n  print(item)\n'
    'while total > 0:\n  total = total - 1\n'
    'def add(left, right):\n  return left + right\n'
    'items = [1, 2, 3]\nvalue = items[0]\n'
    'record = {"name": "Ada"}\n'
    '# a comment\nvalue = 1  # inline comment\n\n'
    'from math import sqrt\nimport os\n'
  ]

  for source in cases
    document = python.parse(source)
    strictEqual(document.stringify(), source, "Round-trips #{JSON.stringify(source)}")
    ok(document.serialize().indexOf('<block') >= 0, 'Produces structural blocks')
  start()
