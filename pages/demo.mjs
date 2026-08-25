import {DropletEditor} from '@droplet/editor';
import {javascript} from '@droplet/javascript';
import {createPythonLanguage} from '@droplet/python';

window.brython();
const python = createPythonLanguage({
  pythonToAST: window.__BRYTHON__.pythonToAST,
  tokenize: window.__BRYTHON__.tokenizer
});

mount('javascript', javascript, 'let score = 0;\nif (score < 3) {\n  score += 1;\n}\n');
mount('python', python, 'score = 0\nif score < 3:\n  score += 1\n');

function mount(id, language, value) {
  const source = document.querySelector(`#${id}-source`);
  const button = document.querySelector(`[data-mode="${id}"]`);
  const editor = new DropletEditor(document.querySelector(`#${id}-editor`), {
    language, value, mode: 'blocks', onChange: refresh
  });
  function refresh(nextValue = editor.value) { source.textContent = nextValue; }
  refresh();
  button.addEventListener('click', () => {
    editor.toggleMode();
    button.textContent = editor.mode === 'blocks' ? 'Use text mode' : 'Use block mode';
  });
}
