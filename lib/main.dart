import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';

import 'prototype/workbench.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const WorldPainterApp());
}

class WorldPainterApp extends StatefulWidget {
  const WorldPainterApp({super.key});
  @override
  State<WorldPainterApp> createState() => _WorldPainterAppState();
}

class _WorldPainterAppState extends State<WorldPainterApp> {
  bool dark = true;
  bool reduceMotion = false;
  late final SemanticsHandle semantics;
  @override
  void initState() {
    super.initState();
    semantics = SemanticsBinding.instance.ensureSemantics();
  }

  @override
  void dispose() {
    semantics.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final accent = dark ? const Color(0xFFF5D57A) : const Color(0xFF3B82F6);
    final scheme =
        ColorScheme.fromSeed(
          seedColor: accent,
          brightness: dark ? Brightness.dark : Brightness.light,
        ).copyWith(
          primary: accent,
          onPrimary: dark ? const Color(0xFF211D13) : Colors.white,
          surface: dark ? const Color(0xFF1C1C21) : Colors.white,
          onSurface: dark ? const Color(0xFFF0F0F4) : const Color(0xFF172033),
          onSurfaceVariant: dark
              ? const Color(0xFF92929E)
              : const Color(0xFF5D6B82),
          outlineVariant: dark
              ? const Color(0xFF2E2E35)
              : const Color(0xFFE2E6ED),
        );
    final border = OutlineInputBorder(
      borderRadius: BorderRadius.circular(10),
      borderSide: BorderSide(color: scheme.outlineVariant),
    );
    return MaterialApp(
      title: '绘世 · WorldPainter',
      debugShowCheckedModeBanner: false,
      themeAnimationDuration: Duration(milliseconds: reduceMotion ? 0 : 180),
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: scheme,
        fontFamily: 'NotoSansSC',
        scaffoldBackgroundColor: dark
            ? const Color(0xFF0A0A0C)
            : const Color(0xFFF2F4F8),
        textTheme: const TextTheme(
          bodyMedium: TextStyle(fontSize: 13, height: 1.55),
          bodySmall: TextStyle(fontSize: 11, height: 1.5),
          titleSmall: TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
        ),
        tooltipTheme: const TooltipThemeData(
          waitDuration: Duration(milliseconds: 500),
        ),
        dividerTheme: DividerThemeData(
          color: scheme.outlineVariant,
          thickness: 1,
          space: 1,
        ),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: dark ? const Color(0xFF141417) : const Color(0xFFF7F9FC),
          isDense: true,
          contentPadding: const EdgeInsets.symmetric(
            horizontal: 12,
            vertical: 13,
          ),
          border: border,
          enabledBorder: border,
          focusedBorder: border.copyWith(borderSide: BorderSide(color: accent)),
          hintStyle: TextStyle(color: scheme.onSurfaceVariant, fontSize: 12),
        ),
        iconButtonTheme: IconButtonThemeData(
          style: IconButton.styleFrom(
            foregroundColor: scheme.onSurfaceVariant,
            iconSize: 18,
            minimumSize: const Size(34, 34),
            padding: const EdgeInsets.all(8),
          ),
        ),
        filledButtonTheme: FilledButtonThemeData(
          style: FilledButton.styleFrom(
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(10),
            ),
            textStyle: const TextStyle(
              fontFamily: 'NotoSansSC',
              fontSize: 13,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
        sliderTheme: const SliderThemeData(
          trackHeight: 3,
          thumbShape: RoundSliderThumbShape(enabledThumbRadius: 6),
        ),
        scrollbarTheme: ScrollbarThemeData(
          thumbColor: WidgetStatePropertyAll(scheme.outlineVariant),
          thickness: const WidgetStatePropertyAll(4),
        ),
      ),
      home: Workbench(
        dark: dark,
        reduceMotion: reduceMotion,
        onThemeChanged: () => setState(() => dark = !dark),
        onMotionChanged: (value) => setState(() => reduceMotion = value),
      ),
    );
  }
}
