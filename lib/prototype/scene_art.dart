import 'dart:math' as math;

import 'package:flutter/material.dart';

/// A self-contained, procedurally painted landscape used by the desktop
/// prototype. The artwork scales with its parent and makes no network or asset
/// requests.
class SceneArt extends StatelessWidget {
  const SceneArt({super.key, this.variant = 0});

  final int variant;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth.isFinite
            ? constraints.maxWidth
            : 360.0;
        final height = constraints.maxHeight.isFinite
            ? constraints.maxHeight
            : 560.0;
        return CustomPaint(
          size: Size(width, height),
          painter: _SceneArtPainter(variant),
        );
      },
    );
  }
}

class _SceneArtPainter extends CustomPainter {
  const _SceneArtPainter(this.variant);

  final int variant;

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;

    canvas.save();
    canvas.clipRect(Offset.zero & size);
    switch (((variant % 3) + 3) % 3) {
      case 1:
        _paintGreenValley(canvas, size);
        break;
      case 2:
        _paintAmberCoast(canvas, size);
        break;
      default:
        _paintBlueNight(canvas, size);
        break;
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _SceneArtPainter oldDelegate) =>
      oldDelegate.variant != variant;

  void _paintBlueNight(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    final w = size.width;
    final h = size.height;
    _gradient(canvas, rect, const [
      Color(0xFF101B35),
      Color(0xFF172844),
      Color(0xFF243C50),
    ]);

    final moon = Offset(w * 0.72, h * 0.235);
    final moonRadius = math.min(w, h) * 0.057;
    _glow(canvas, moon, moonRadius * 3.8, const Color(0xFFE6C88C), 0.17);
    canvas.drawCircle(
      moon,
      moonRadius,
      Paint()
        ..shader = const RadialGradient(
          colors: [Color(0xFFFFF2CE), Color(0xFFE9C98C)],
        ).createShader(Rect.fromCircle(center: moon, radius: moonRadius)),
    );
    canvas.drawCircle(
      Offset(moon.dx - moonRadius * 0.31, moon.dy - moonRadius * 0.2),
      moonRadius * 0.11,
      Paint()..color = const Color(0xFFCEAE78).withValues(alpha: 0.32),
    );
    _starField(canvas, size, seed: 0x59A17, count: 54, color: 0xFFD7AC70);
    _drawSparkle(
      canvas,
      Offset(w * 0.19, h * 0.22),
      math.min(w, h) * 0.008,
      const Color(0xFFFFDDA3).withValues(alpha: 0.84),
    );
    _drawSparkle(
      canvas,
      Offset(w * 0.88, h * 0.38),
      math.min(w, h) * 0.006,
      const Color(0xFFC3D9D5).withValues(alpha: 0.75),
    );

    _drawRidge(
      canvas,
      size,
      const [
        Offset(-0.06, 0.47),
        Offset(0.12, 0.36),
        Offset(0.24, 0.43),
        Offset(0.4, 0.29),
        Offset(0.53, 0.4),
        Offset(0.68, 0.33),
        Offset(0.8, 0.43),
        Offset(0.94, 0.32),
        Offset(1.08, 0.44),
      ],
      const Color(0xFF263951),
      const Color(0xFF405267),
    );
    _drawRidge(
      canvas,
      size,
      const [
        Offset(-0.08, 0.55),
        Offset(0.13, 0.46),
        Offset(0.27, 0.51),
        Offset(0.43, 0.4),
        Offset(0.55, 0.49),
        Offset(0.72, 0.42),
        Offset(0.87, 0.52),
        Offset(1.1, 0.42),
      ],
      const Color(0xFF233B4A),
      const Color(0xFF2D4B59),
    );
    _drawRidge(
      canvas,
      size,
      const [
        Offset(-0.08, 0.64),
        Offset(0.12, 0.55),
        Offset(0.28, 0.61),
        Offset(0.45, 0.52),
        Offset(0.61, 0.6),
        Offset(0.78, 0.53),
        Offset(0.91, 0.59),
        Offset(1.08, 0.51),
      ],
      const Color(0xFF1A3445),
      const Color(0xFF244453),
    );

    final waterRect = Rect.fromLTWH(0, h * 0.665, w, h * 0.335);
    _gradient(
      canvas,
      waterRect,
      const [Color(0xFF18364A), Color(0xFF142D41), Color(0xFF0C1D30)],
      begin: Alignment.topCenter,
      end: Alignment.bottomCenter,
    );
    _drawNightWaterReflection(canvas, size, seed: 0xA912, centerX: 0.72);

    _drawNightShore(canvas, size);
    _drawPineGroup(
      canvas,
      size,
      const [
        Offset(0.035, 0.63),
        Offset(0.092, 0.617),
        Offset(0.165, 0.635),
        Offset(0.235, 0.605),
        Offset(0.82, 0.64),
        Offset(0.9, 0.63),
        Offset(0.965, 0.614),
      ],
      color: const Color(0xFF102935),
      heightFactor: 0.064,
    );
    _vignette(canvas, size, const Color(0xFF08121F), strength: 0.35);
  }

  void _paintGreenValley(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    final w = size.width;
    final h = size.height;
    _gradient(canvas, rect, const [
      Color(0xFFA9C8B8),
      Color(0xFF789D8C),
      Color(0xFF476E66),
    ]);
    final sun = Offset(w * 0.51, h * 0.235);
    final sunRadius = math.min(w, h) * 0.044;
    _glow(canvas, sun, sunRadius * 4.4, const Color(0xFFFFE7AF), 0.22);
    canvas.drawCircle(
      sun,
      sunRadius,
      Paint()
        ..shader = const RadialGradient(
          colors: [Color(0xFFFFF6D7), Color(0xFFECD9A8)],
        ).createShader(Rect.fromCircle(center: sun, radius: sunRadius)),
    );
    _starField(
      canvas,
      size,
      seed: 0x3E71,
      count: 22,
      color: 0xFFDCE5BD,
      maxY: 0.43,
      minRadius: 0.35,
      maxRadius: 0.8,
    );

    _drawRidge(
      canvas,
      size,
      const [
        Offset(-0.08, 0.49),
        Offset(0.1, 0.37),
        Offset(0.25, 0.45),
        Offset(0.39, 0.3),
        Offset(0.52, 0.44),
        Offset(0.68, 0.32),
        Offset(0.8, 0.43),
        Offset(0.93, 0.34),
        Offset(1.08, 0.47),
      ],
      const Color(0xFF648C80),
      const Color(0xFF86A99A),
    );
    _drawRidge(
      canvas,
      size,
      const [
        Offset(-0.08, 0.58),
        Offset(0.14, 0.46),
        Offset(0.27, 0.54),
        Offset(0.43, 0.41),
        Offset(0.58, 0.52),
        Offset(0.74, 0.42),
        Offset(0.88, 0.53),
        Offset(1.08, 0.43),
      ],
      const Color(0xFF477564),
      const Color(0xFF65917B),
    );
    _drawRidge(
      canvas,
      size,
      const [
        Offset(-0.08, 0.69),
        Offset(0.12, 0.55),
        Offset(0.3, 0.64),
        Offset(0.45, 0.54),
        Offset(0.62, 0.65),
        Offset(0.78, 0.53),
        Offset(0.92, 0.62),
        Offset(1.08, 0.54),
      ],
      const Color(0xFF315F53),
      const Color(0xFF4D7963),
    );

    _drawValleyFloor(canvas, size);
    _drawRiver(canvas, size);
    _drawPineGroup(
      canvas,
      size,
      const [
        Offset(0.015, 0.69),
        Offset(0.07, 0.655),
        Offset(0.125, 0.675),
        Offset(0.19, 0.64),
        Offset(0.26, 0.68),
        Offset(0.78, 0.67),
        Offset(0.84, 0.635),
        Offset(0.9, 0.66),
        Offset(0.97, 0.625),
        Offset(1.02, 0.65),
      ],
      color: const Color(0xFF244B42),
      heightFactor: 0.075,
    );
    _drawValleyGlints(canvas, size);
    _vignette(canvas, size, const Color(0xFF183C39), strength: 0.22);
  }

  void _paintAmberCoast(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    final w = size.width;
    final h = size.height;
    _gradient(canvas, rect, const [
      Color(0xFF442B42),
      Color(0xFF9A4E4C),
      Color(0xFFE18B58),
    ]);
    final sun = Offset(w * 0.5, h * 0.565);
    final sunRadius = math.min(w, h) * 0.13;
    _glow(canvas, sun, sunRadius * 2.7, const Color(0xFFFFC876), 0.25);
    canvas.drawCircle(
      sun,
      sunRadius,
      Paint()
        ..shader = const RadialGradient(
          colors: [Color(0xFFFFF0C3), Color(0xFFFFC779), Color(0xFFE99562)],
          stops: [0, 0.7, 1],
        ).createShader(Rect.fromCircle(center: sun, radius: sunRadius)),
    );
    _paintSunsetClouds(canvas, size);
    _starField(
      canvas,
      size,
      seed: 0xC057,
      count: 18,
      color: 0xFFFFD39A,
      minY: 0.06,
      maxY: 0.34,
      minRadius: 0.35,
      maxRadius: 0.85,
    );
    _drawBirds(canvas, size);

    final seaRect = Rect.fromLTWH(0, h * 0.585, w, h * 0.415);
    _gradient(
      canvas,
      seaRect,
      const [Color(0xFF844B51), Color(0xFF543747), Color(0xFF282A3B)],
      begin: Alignment.topCenter,
      end: Alignment.bottomCenter,
    );
    _drawCoastalIslands(canvas, size);
    _drawSunsetReflection(canvas, size, seed: 0xCE57);
    _drawCoastCliffs(canvas, size);
    _vignette(canvas, size, const Color(0xFF281E35), strength: 0.26);
  }

  void _drawRidge(
    Canvas canvas,
    Size size,
    List<Offset> normalized,
    Color top,
    Color bottom,
  ) {
    final points = normalized
        .map((p) => Offset(p.dx * size.width, p.dy * size.height))
        .toList(growable: false);
    final path = Path()..moveTo(points.first.dx, points.first.dy);
    for (final point in points.skip(1)) {
      path.lineTo(point.dx, point.dy);
    }
    path
      ..lineTo(size.width, size.height)
      ..lineTo(0, size.height)
      ..close();
    canvas.drawPath(
      path,
      Paint()
        ..shader = LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [top, bottom],
        ).createShader(Offset.zero & size),
    );
  }

  void _drawValleyFloor(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final path = Path()
      ..moveTo(0, h * 0.68)
      ..cubicTo(w * 0.2, h * 0.7, w * 0.27, h * 0.63, w * 0.44, h * 0.66)
      ..cubicTo(w * 0.6, h * 0.69, w * 0.79, h * 0.61, w, h * 0.65)
      ..lineTo(w, h)
      ..lineTo(0, h)
      ..close();
    canvas.drawPath(
      path,
      Paint()
        ..shader = const LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [Color(0xFF3C6C59), Color(0xFF234B45)],
        ).createShader(Offset.zero & size),
    );
    final haze = Path()
      ..moveTo(0, h * 0.7)
      ..quadraticBezierTo(w * 0.52, h * 0.65, w, h * 0.68);
    canvas.drawPath(
      haze,
      Paint()
        ..color = const Color(0xFFC5D6B6).withValues(alpha: 0.16)
        ..strokeWidth = math.max(1, size.shortestSide * 0.014)
        ..style = PaintingStyle.stroke,
    );
  }

  void _drawNightShore(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final shorePaint = Paint()
      ..shader = const LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [Color(0xFF1A3440), Color(0xFF0C202C)],
      ).createShader(Offset.zero & size);
    final left = Path()
      ..moveTo(0, h * 0.655)
      ..cubicTo(w * 0.09, h * 0.625, w * 0.13, h * 0.66, w * 0.22, h * 0.67)
      ..cubicTo(w * 0.27, h * 0.68, w * 0.3, h * 0.705, w * 0.36, h * 0.725)
      ..lineTo(w * 0.31, h)
      ..lineTo(0, h)
      ..close();
    final right = Path()
      ..moveTo(w, h * 0.645)
      ..cubicTo(w * 0.94, h * 0.66, w * 0.91, h * 0.685, w * 0.86, h * 0.715)
      ..cubicTo(w * 0.94, h * 0.75, w * 0.95, h * 0.8, w, h * 0.84)
      ..close();
    canvas
      ..drawPath(left, shorePaint)
      ..drawPath(right, shorePaint);
    final shoreline = Path()
      ..moveTo(0, h * 0.655)
      ..cubicTo(w * 0.09, h * 0.625, w * 0.13, h * 0.66, w * 0.22, h * 0.67)
      ..cubicTo(w * 0.27, h * 0.68, w * 0.3, h * 0.705, w * 0.36, h * 0.725)
      ..moveTo(w, h * 0.645)
      ..cubicTo(w * 0.94, h * 0.66, w * 0.91, h * 0.685, w * 0.86, h * 0.715);
    canvas.drawPath(
      shoreline,
      Paint()
        ..color = const Color(0xFF8FB1AD).withValues(alpha: 0.27)
        ..strokeWidth = math.max(1, size.shortestSide * 0.004)
        ..strokeCap = StrokeCap.round
        ..style = PaintingStyle.stroke,
    );
  }

  void _drawRiver(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final river = Path()
      ..moveTo(w * 0.53, h * 0.57)
      ..cubicTo(w * 0.59, h * 0.64, w * 0.34, h * 0.71, w * 0.49, h * 0.78)
      ..cubicTo(w * 0.67, h * 0.86, w * 0.43, h * 0.91, w * 0.58, h * 1.03);
    canvas.drawPath(
      river,
      Paint()
        ..color = const Color(0xFF9DBDA4).withValues(alpha: 0.38)
        ..strokeWidth = w * 0.205
        ..strokeCap = StrokeCap.round
        ..style = PaintingStyle.stroke
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 9),
    );
    canvas.drawPath(
      river,
      Paint()
        ..shader = const LinearGradient(
          begin: Alignment.centerLeft,
          end: Alignment.centerRight,
          colors: [Color(0xFF6EAA91), Color(0xFFC7D7B1), Color(0xFF72A891)],
        ).createShader(Offset.zero & size)
        ..strokeWidth = w * 0.132
        ..strokeCap = StrokeCap.round
        ..style = PaintingStyle.stroke,
    );
    canvas.drawPath(
      river,
      Paint()
        ..color = const Color(0xFFE5E5C5).withValues(alpha: 0.54)
        ..strokeWidth = math.max(1, w * 0.008)
        ..strokeCap = StrokeCap.round
        ..style = PaintingStyle.stroke,
    );
  }

  void _drawNightWaterReflection(
    Canvas canvas,
    Size size, {
    required int seed,
    required double centerX,
  }) {
    final w = size.width;
    final h = size.height;
    final clip = Rect.fromLTWH(0, h * 0.665, w, h * 0.335);
    canvas.save();
    canvas.clipRect(clip);
    final random = math.Random(seed);
    final gold = Path();
    final pale = Path();
    for (var i = 0; i < 78; i++) {
      final y = h * (0.685 + random.nextDouble() * 0.31);
      final spread = 0.045 + ((y / h) - 0.68) * 0.43;
      final x = w * (centerX + (random.nextDouble() * 2 - 1) * spread);
      final length =
          w *
          (0.012 + random.nextDouble() * 0.095) *
          (1 - ((x / w) - centerX).abs() * 0.85);
      final path = i % 5 == 0 ? gold : pale;
      path
        ..moveTo(x - length * 0.5, y)
        ..quadraticBezierTo(x, y - h * 0.002, x + length * 0.5, y);
    }
    canvas.drawPath(
      pale,
      Paint()
        ..color = const Color(0xFF8BB9B6).withValues(alpha: 0.17)
        ..strokeWidth = math.max(0.6, size.shortestSide * 0.0022)
        ..strokeCap = StrokeCap.round
        ..style = PaintingStyle.stroke,
    );
    canvas.drawPath(
      gold,
      Paint()
        ..color = const Color(0xFFEACB91).withValues(alpha: 0.3)
        ..strokeWidth = math.max(0.7, size.shortestSide * 0.0028)
        ..strokeCap = StrokeCap.round
        ..style = PaintingStyle.stroke,
    );
    canvas.restore();
  }

  void _drawValleyGlints(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final path = Path()
      ..moveTo(w * 0.43, h * 0.72)
      ..quadraticBezierTo(w * 0.49, h * 0.735, w * 0.55, h * 0.72)
      ..moveTo(w * 0.45, h * 0.83)
      ..quadraticBezierTo(w * 0.52, h * 0.84, w * 0.6, h * 0.82)
      ..moveTo(w * 0.48, h * 0.94)
      ..quadraticBezierTo(w * 0.56, h * 0.95, w * 0.64, h * 0.93);
    canvas.drawPath(
      path,
      Paint()
        ..color = const Color(0xFFE1E2BD).withValues(alpha: 0.38)
        ..strokeWidth = math.max(1, w * 0.006)
        ..strokeCap = StrokeCap.round
        ..style = PaintingStyle.stroke,
    );
    _drawSparkle(
      canvas,
      Offset(w * 0.81, h * 0.39),
      size.shortestSide * 0.006,
      const Color(0xFFFFE5B1).withValues(alpha: 0.74),
    );
  }

  void _paintSunsetClouds(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final cloudPaint = Paint()
      ..color = const Color(0xFF4F3547).withValues(alpha: 0.24);
    final warmCloud = Paint()
      ..color = const Color(0xFFF5B27B).withValues(alpha: 0.24);
    final cloudOne = Path()
      ..moveTo(w * 0.08, h * 0.28)
      ..cubicTo(w * 0.16, h * 0.25, w * 0.21, h * 0.27, w * 0.29, h * 0.255)
      ..cubicTo(w * 0.36, h * 0.24, w * 0.42, h * 0.27, w * 0.48, h * 0.26)
      ..lineTo(w * 0.47, h * 0.275)
      ..cubicTo(w * 0.34, h * 0.29, w * 0.2, h * 0.283, w * 0.08, h * 0.3)
      ..close();
    final cloudTwo = Path()
      ..moveTo(w * 0.63, h * 0.35)
      ..cubicTo(w * 0.7, h * 0.33, w * 0.76, h * 0.34, w * 0.84, h * 0.32)
      ..cubicTo(w * 0.9, h * 0.31, w * 0.94, h * 0.33, w * 1.02, h * 0.315)
      ..lineTo(w * 1.02, h * 0.34)
      ..cubicTo(w * 0.87, h * 0.35, w * 0.75, h * 0.36, w * 0.63, h * 0.37)
      ..close();
    canvas
      ..drawPath(cloudOne, cloudPaint)
      ..drawPath(cloudTwo, cloudPaint);
    final highlight = Path()
      ..moveTo(w * 0.11, h * 0.276)
      ..quadraticBezierTo(w * 0.3, h * 0.26, w * 0.43, h * 0.27)
      ..moveTo(w * 0.67, h * 0.348)
      ..quadraticBezierTo(w * 0.83, h * 0.33, w * 0.98, h * 0.336);
    canvas.drawPath(
      highlight,
      Paint()
        ..color = warmCloud.color
        ..strokeWidth = math.max(1, size.shortestSide * 0.004)
        ..strokeCap = StrokeCap.round
        ..style = PaintingStyle.stroke,
    );
  }

  void _drawCoastalIslands(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final islandPaint = Paint()
      ..color = const Color(0xFF493746).withValues(alpha: 0.75);
    final left = Path()
      ..moveTo(0, h * 0.61)
      ..cubicTo(w * 0.12, h * 0.605, w * 0.18, h * 0.59, w * 0.27, h * 0.6)
      ..cubicTo(w * 0.33, h * 0.605, w * 0.36, h * 0.62, w * 0.42, h * 0.615)
      ..lineTo(w * 0.42, h * 0.645)
      ..lineTo(0, h * 0.645)
      ..close();
    final right = Path()
      ..moveTo(w * 0.7, h * 0.615)
      ..cubicTo(w * 0.78, h * 0.605, w * 0.82, h * 0.585, w * 0.89, h * 0.602)
      ..cubicTo(w * 0.94, h * 0.612, w * 0.98, h * 0.595, w, h * 0.605)
      ..lineTo(w, h * 0.65)
      ..lineTo(w * 0.7, h * 0.65)
      ..close();
    canvas
      ..drawPath(left, islandPaint)
      ..drawPath(right, islandPaint);
    final glimmer = Path()
      ..moveTo(0, h * 0.585)
      ..quadraticBezierTo(w * 0.5, h * 0.59, w, h * 0.584);
    canvas.drawPath(
      glimmer,
      Paint()
        ..color = const Color(0xFFFFD99B).withValues(alpha: 0.36)
        ..strokeWidth = math.max(1, size.shortestSide * 0.004)
        ..style = PaintingStyle.stroke,
    );
  }

  void _drawSunsetReflection(Canvas canvas, Size size, {required int seed}) {
    final w = size.width;
    final h = size.height;
    final clip = Rect.fromLTWH(0, h * 0.585, w, h * 0.415);
    canvas.save();
    canvas.clipRect(clip);
    final random = math.Random(seed);
    final reflection = Path();
    final subtle = Path();
    for (var i = 0; i < 92; i++) {
      final y = h * (0.59 + random.nextDouble() * 0.38);
      final spread = 0.018 + (y / h - 0.59) * 0.2;
      final x = w * (0.5 + (random.nextDouble() * 2 - 1) * spread);
      final length =
          w *
          (0.012 + random.nextDouble() * 0.12) *
          (1 - (x / w - 0.5).abs() * 1.3);
      final path = i % 4 == 0 ? reflection : subtle;
      path
        ..moveTo(x - length * 0.5, y)
        ..lineTo(x + length * 0.5, y);
    }
    canvas.drawPath(
      subtle,
      Paint()
        ..color = const Color(0xFFE99367).withValues(alpha: 0.2)
        ..strokeWidth = math.max(0.6, size.shortestSide * 0.002)
        ..strokeCap = StrokeCap.round
        ..style = PaintingStyle.stroke,
    );
    canvas.drawPath(
      reflection,
      Paint()
        ..color = const Color(0xFFFFCF86).withValues(alpha: 0.56)
        ..strokeWidth = math.max(0.8, size.shortestSide * 0.0032)
        ..strokeCap = StrokeCap.round
        ..style = PaintingStyle.stroke,
    );
    canvas.restore();
  }

  void _drawCoastCliffs(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final left = Path()
      ..moveTo(0, h * 0.77)
      ..cubicTo(w * 0.1, h * 0.75, w * 0.14, h * 0.8, w * 0.23, h * 0.81)
      ..cubicTo(w * 0.31, h * 0.83, w * 0.34, h * 0.87, w * 0.42, h * 0.9)
      ..lineTo(w * 0.35, h)
      ..lineTo(0, h)
      ..close();
    final right = Path()
      ..moveTo(w, h * 0.72)
      ..cubicTo(w * 0.91, h * 0.76, w * 0.9, h * 0.81, w * 0.82, h * 0.84)
      ..cubicTo(w * 0.74, h * 0.87, w * 0.7, h * 0.92, w * 0.64, h)
      ..lineTo(w, h)
      ..close();
    final rockPaint = Paint()
      ..shader = LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [const Color(0xFF493044), const Color(0xFF242638)],
      ).createShader(Offset.zero & size);
    canvas
      ..drawPath(left, rockPaint)
      ..drawPath(right, rockPaint);
    final edge = Path()
      ..moveTo(0, h * 0.77)
      ..cubicTo(w * 0.1, h * 0.75, w * 0.14, h * 0.8, w * 0.23, h * 0.81)
      ..cubicTo(w * 0.31, h * 0.83, w * 0.34, h * 0.87, w * 0.42, h * 0.9)
      ..moveTo(w, h * 0.72)
      ..cubicTo(w * 0.91, h * 0.76, w * 0.9, h * 0.81, w * 0.82, h * 0.84)
      ..cubicTo(w * 0.74, h * 0.87, w * 0.7, h * 0.92, w * 0.64, h);
    canvas.drawPath(
      edge,
      Paint()
        ..color = const Color(0xFFFFC277).withValues(alpha: 0.52)
        ..strokeWidth = math.max(1, size.shortestSide * 0.006)
        ..strokeCap = StrokeCap.round
        ..style = PaintingStyle.stroke,
    );
  }

  void _drawPineGroup(
    Canvas canvas,
    Size size,
    List<Offset> positions, {
    required Color color,
    required double heightFactor,
  }) {
    final w = size.width;
    final h = size.height;
    final trees = Path();
    final trunks = Path();
    for (var i = 0; i < positions.length; i++) {
      final anchor = Offset(positions[i].dx * w, positions[i].dy * h);
      final height = h * heightFactor * (i.isEven ? 1 : 0.75);
      final halfWidth = height * 0.36;
      final top = anchor.dy - height;
      trees
        ..moveTo(anchor.dx, top)
        ..lineTo(anchor.dx - halfWidth, anchor.dy - height * 0.25)
        ..lineTo(anchor.dx - halfWidth * 0.42, anchor.dy - height * 0.3)
        ..lineTo(anchor.dx - halfWidth * 1.15, anchor.dy - height * 0.04)
        ..lineTo(anchor.dx + halfWidth * 1.15, anchor.dy - height * 0.04)
        ..lineTo(anchor.dx + halfWidth * 0.42, anchor.dy - height * 0.3)
        ..lineTo(anchor.dx + halfWidth, anchor.dy - height * 0.25)
        ..close();
      trunks
        ..moveTo(anchor.dx, anchor.dy - height * 0.12)
        ..lineTo(anchor.dx, anchor.dy + height * 0.05);
    }
    canvas.drawPath(trees, Paint()..color = color);
    canvas.drawPath(
      trunks,
      Paint()
        ..color = color.withValues(alpha: 0.84)
        ..strokeWidth = math.max(1, size.shortestSide * 0.002)
        ..style = PaintingStyle.stroke,
    );
  }

  void _drawBirds(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final birds = Path()
      ..moveTo(w * 0.24, h * 0.19)
      ..quadraticBezierTo(w * 0.255, h * 0.205, w * 0.27, h * 0.19)
      ..quadraticBezierTo(w * 0.285, h * 0.175, w * 0.3, h * 0.19)
      ..moveTo(w * 0.76, h * 0.22)
      ..quadraticBezierTo(w * 0.772, h * 0.232, w * 0.784, h * 0.22)
      ..quadraticBezierTo(w * 0.796, h * 0.207, w * 0.808, h * 0.22);
    canvas.drawPath(
      birds,
      Paint()
        ..color = const Color(0xFF493144).withValues(alpha: 0.58)
        ..strokeWidth = math.max(1, size.shortestSide * 0.004)
        ..strokeCap = StrokeCap.round
        ..style = PaintingStyle.stroke,
    );
  }

  void _starField(
    Canvas canvas,
    Size size, {
    required int seed,
    required int count,
    required int color,
    double minY = 0.04,
    double maxY = 0.48,
    double minRadius = 0.45,
    double maxRadius = 1.15,
  }) {
    final random = math.Random(seed);
    final dots = Path();
    final radiusScale = size.shortestSide / 360;
    for (var i = 0; i < count; i++) {
      final x = random.nextDouble() * size.width;
      final y = size.height * (minY + random.nextDouble() * (maxY - minY));
      final radius =
          (minRadius + random.nextDouble() * (maxRadius - minRadius)) *
          radiusScale;
      dots.addOval(Rect.fromCircle(center: Offset(x, y), radius: radius));
    }
    canvas.drawPath(
      dots,
      Paint()
        ..color = Color(color).withValues(alpha: 0.75)
        ..style = PaintingStyle.fill,
    );
  }

  void _drawSparkle(Canvas canvas, Offset center, double radius, Color color) {
    final path = Path()
      ..moveTo(center.dx, center.dy - radius * 1.9)
      ..quadraticBezierTo(
        center.dx + radius * 0.22,
        center.dy - radius * 0.22,
        center.dx + radius * 1.8,
        center.dy,
      )
      ..quadraticBezierTo(
        center.dx + radius * 0.22,
        center.dy + radius * 0.22,
        center.dx,
        center.dy + radius * 1.9,
      )
      ..quadraticBezierTo(
        center.dx - radius * 0.22,
        center.dy + radius * 0.22,
        center.dx - radius * 1.8,
        center.dy,
      )
      ..quadraticBezierTo(
        center.dx - radius * 0.22,
        center.dy - radius * 0.22,
        center.dx,
        center.dy - radius * 1.9,
      )
      ..close();
    canvas.drawPath(path, Paint()..color = color);
  }

  void _glow(
    Canvas canvas,
    Offset center,
    double radius,
    Color color,
    double strength,
  ) {
    canvas.drawCircle(
      center,
      radius,
      Paint()
        ..shader = RadialGradient(
          colors: [
            color.withValues(alpha: strength),
            color.withValues(alpha: strength * 0.34),
            color.withValues(alpha: 0),
          ],
          stops: const [0, 0.48, 1],
        ).createShader(Rect.fromCircle(center: center, radius: radius)),
    );
  }

  void _gradient(
    Canvas canvas,
    Rect rect,
    List<Color> colors, {
    Alignment begin = Alignment.topCenter,
    Alignment end = Alignment.bottomCenter,
  }) {
    canvas.drawRect(
      rect,
      Paint()
        ..shader = LinearGradient(
          begin: begin,
          end: end,
          colors: colors,
        ).createShader(rect),
    );
  }

  void _vignette(
    Canvas canvas,
    Size size,
    Color color, {
    required double strength,
  }) {
    final rect = Offset.zero & size;
    canvas.drawRect(
      rect,
      Paint()
        ..shader = RadialGradient(
          center: Alignment.center,
          radius: 1.05,
          colors: [
            color.withValues(alpha: 0),
            color.withValues(alpha: strength * 0.28),
            color.withValues(alpha: strength),
          ],
          stops: const [0, 0.68, 1],
        ).createShader(rect),
    );
  }
}
