// A representative JavaScript compatibility corpus.
var answer = 1;
var total = answer + 2 * (3 + 4);
announce("total", total);
outer(inner(1));

if (total > 10) {
  announce("large");
} else {
  announce('small');
}

for (var i = 0; i < 3; i++) {
  items.push(i);
}
while (items.length > 0) {
  items.pop();
}
function add(left, right) {
  return left + right;
}
var values = [1, 2, 3];
var options = {enabled: true, label: "demo"};
var note = "double"; // inline comment
