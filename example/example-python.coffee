createEditor = ->
  editor = new droplet.Editor document.getElementById('droplet-editor'), {
    mode: 'python'
    modeOptions: {
      functions: {
        print: {color: 'blue'}
        range: {value: true, color: 'green'}
      }
    }
    palette: [
      {
        name: 'Python'
        color: 'blue'
        blocks: [
          {block: 'print("hello")\n'}
          {block: 'value = 1\n'}
        ]
      }
    ]
  }

  editor.setValue 'for item in range(3):\n  print(item)\n'
  window.editor = editor

createEditor()

document.getElementById('toggle').addEventListener 'click', ->
  window.editor.toggleBlocks()
