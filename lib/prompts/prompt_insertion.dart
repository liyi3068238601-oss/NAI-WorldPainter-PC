/// Appends without rewriting existing weights, punctuation or line breaks.
String appendPromptText(String current, String addition) {
  if (addition.trim().isEmpty) return current;
  if (current.trim().isEmpty) return addition;
  final tail = current.trimRight();
  final separator = tail.endsWith(',') || current.endsWith('\n') ? ' ' : ', ';
  return '$current$separator$addition';
}
