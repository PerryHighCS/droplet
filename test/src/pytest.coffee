Python = require '../../src/languages/python.coffee'
droplet = require '../../dist/droplet-full.js'

asyncTest 'Python 3 compatibility corpus round-trips through blocks', ->
  python = new Python({functions: {}})
  cases = [
    'total = 1 + 2.5\n'
    "label = 'hello'\n"
    'message = "hello"\n'
    'enabled = total > 0 and total < 10\n'
    'result = outer(inner(1))\n'
    'name = input("Name: ")\n'
    'if total > 2:\n  print(total)\nelse:\n  print(0)\n'
    'if score > 90:\n  grade = "A"\nelif score > 80:\n  grade = "B"\nelse:\n  grade = "C"\n'
    'for item in range(3):\n  print(item)\n'
    'for character in "abc":\n  print(character)\n'
    'while total > 0:\n  total = total - 1\n'
    'def add(left, right):\n  return left + right\n'
    'items = [1, 2, 3]\nvalue = items[0]\n'
    'first_letter = message[0]\n'
    'record = {"name": "Ada"}\n'
    '# a comment\nvalue = 1  # inline comment\n\n'
    'from math import sqrt\nimport os\n'
  ]

  for source in cases
    document = python.parse(source)
    strictEqual(document.stringify(), source, "Round-trips #{JSON.stringify(source)}")
    ok(document.serialize().indexOf('<block') >= 0, 'Produces structural blocks')
  start()

asyncTest 'Python lexical formatting round-trips exactly', ->
  $.get 'data/python-lexical-compatibility.py', (source) ->
    python = new Python({functions: {}})
    strictEqual(python.parse(source).stringify(), source,
      'Quotes, escapes, comments, whitespace, indentation, and continuations survive')
    start()

asyncTest 'Python block socket edit preserves source and supports undo and redo', ->
  document.getElementById('hidden').innerHTML = '<div id="test-main"></div>'
  editor = new droplet.Editor(document.getElementById('test-main'), {
    mode: 'python'
    palette: []
  })
  editor.setEditorState(true)
  editor.setValue('total = 1\n')

  socket = editor.session.tree.getFromTextLocation({
    row: 0
    col: 'total = '.length
    type: 'socket'
  })
  editor.setCursor(socket)
  ok(editor.cursorAtSocket(), 'The Python literal is editable as a block socket')

  editor.populateSocket(editor.getCursor(), '2')
  editor.setCursor(editor.session.tree.start)

  setTimeout (->
    strictEqual(editor.getValue(), 'total = 2\n', 'Block socket edit updates source')
    editor.undo()

    setTimeout (->
      strictEqual(editor.getValue(), 'total = 1\n', 'Undo restores Python source')
      editor.redo()

      setTimeout (->
        strictEqual(editor.getValue(), 'total = 2\n', 'Redo restores Python edit')
        start()
      ), 0
    ), 0
  ), 0

asyncTest 'Historical Python print and for blocks remain structured', ->
  python = new Python({functions: {}})
  printDocument = python.parse("print 'hello'\n")
  forDocument = python.parse('for item in range(3):\n  print(item)\n')

  strictEqual(printDocument.stringify(), "print 'hello'\n", 'Python 2 print round-trips')
  ok(printDocument.serialize().indexOf('color="command"') >= 0,
    'Python 2 print is a command block')
  strictEqual(forDocument.stringify(), 'for item in range(3):\n  print(item)\n',
    'Historical for loop round-trips')
  ok(forDocument.serialize().indexOf('color="control"') >= 0,
    'For loop is a control block')
  ok(forDocument.serialize().indexOf('<indent') >= 0, 'For loop retains its indent block')
  start()
