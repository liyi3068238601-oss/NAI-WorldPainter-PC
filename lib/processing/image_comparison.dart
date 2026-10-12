import 'package:flutter/material.dart';

import '../media/image_asset_store.dart';
import '../prototype/stored_image.dart';

/// Both images use the same viewport so scale changes can be compared in place.
class ImageComparison extends StatelessWidget {
  const ImageComparison({
    super.key,
    required this.store,
    required this.sourceRef,
    this.resultRef,
    required this.position,
    required this.onChanged,
  });

  final ImageAssetStore store;
  final String sourceRef;
  final String? resultRef;
  final double position;
  final ValueChanged<double> onChanged;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, bounds) {
      final fraction = position.clamp(0.0, 1.0);
      return GestureDetector(
        behavior: HitTestBehavior.opaque,
        onHorizontalDragUpdate: resultRef == null
            ? null
            : (details) => onChanged(
                (fraction + details.delta.dx / bounds.maxWidth).clamp(0.0, 1.0),
              ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(14),
          child: ColoredBox(
            color: const Color(0xff12141b),
            child: Stack(
              fit: StackFit.expand,
              children: [
                StoredImage(store: store, assetRef: resultRef ?? sourceRef),
                if (resultRef != null)
                  ClipRect(
                    clipper: _ComparisonClipper(fraction),
                    child: StoredImage(store: store, assetRef: sourceRef),
                  ),
                Positioned(top: 12, left: 12, child: _tag('原图')),
                if (resultRef != null) ...[
                  Positioned(top: 12, right: 12, child: _tag('处理结果')),
                  Positioned(
                    left: bounds.maxWidth * fraction - 1,
                    top: 0,
                    bottom: 0,
                    width: 2,
                    child: ColoredBox(
                      color: Theme.of(context).colorScheme.primary,
                    ),
                  ),
                  Positioned(
                    left: bounds.maxWidth * fraction - 16,
                    top: bounds.maxHeight / 2 - 16,
                    child: Container(
                      width: 32,
                      height: 32,
                      decoration: BoxDecoration(
                        color: Theme.of(context).colorScheme.primary,
                        shape: BoxShape.circle,
                      ),
                      child: Icon(
                        Icons.swap_horiz,
                        size: 20,
                        color: Theme.of(context).colorScheme.onPrimary,
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      );
    },
  );

  Widget _tag(String text) => DecoratedBox(
    decoration: BoxDecoration(
      color: const Color(0xb0000000),
      borderRadius: BorderRadius.circular(6),
    ),
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      child: Text(
        text,
        style: const TextStyle(color: Colors.white, fontSize: 11),
      ),
    ),
  );
}

class _ComparisonClipper extends CustomClipper<Rect> {
  const _ComparisonClipper(this.fraction);
  final double fraction;
  @override
  Rect getClip(Size size) =>
      Rect.fromLTWH(0, 0, size.width * fraction, size.height);
  @override
  bool shouldReclip(covariant _ComparisonClipper oldClipper) =>
      fraction != oldClipper.fraction;
}
