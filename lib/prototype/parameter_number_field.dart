import 'package:flutter/material.dart';

class ParameterNumberField extends StatefulWidget {
  const ParameterNumberField({
    super.key,
    required this.label,
    required this.value,
    required this.onChanged,
    this.min = 0,
    this.max = 100,
    this.integer = false,
  });
  final String label;
  final num value, min, max;
  final bool integer;
  final ValueChanged<num> onChanged;
  @override
  State<ParameterNumberField> createState() => _ParameterNumberFieldState();
}

class _ParameterNumberFieldState extends State<ParameterNumberField> {
  late final text = TextEditingController(text: widget.value.toString());
  @override
  void didUpdateWidget(ParameterNumberField old) {
    super.didUpdateWidget(old);
    if (old.value != widget.value && num.tryParse(text.text) != widget.value) {
      final expected = widget.value;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && widget.value == expected) {
          text.text = expected.toString();
        }
      });
    }
  }

  @override
  void dispose() {
    text.dispose();
    super.dispose();
  }

  bool valid(num? value) =>
      value != null &&
      value.isFinite &&
      value >= widget.min &&
      value <= widget.max &&
      (!widget.integer || value == value.roundToDouble());
  @override
  Widget build(BuildContext context) => TextFormField(
    controller: text,
    keyboardType: const TextInputType.numberWithOptions(decimal: true),
    style: const TextStyle(fontSize: 12),
    decoration: InputDecoration(labelText: widget.label),
    autovalidateMode: AutovalidateMode.onUserInteraction,
    validator: (text) => valid(num.tryParse(text ?? ''))
        ? null
        : '请输入 ${widget.min}–${widget.max}${widget.integer ? ' 的整数' : ''}',
    onChanged: (text) {
      final parsed = num.tryParse(text);
      if (valid(parsed)) widget.onChanged(parsed!);
    },
  );
}
