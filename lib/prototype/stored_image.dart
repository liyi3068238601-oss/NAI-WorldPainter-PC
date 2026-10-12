import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../media/image_asset_store.dart';

class StoredImage extends StatefulWidget {
  const StoredImage({
    super.key,
    required this.store,
    required this.assetRef,
    this.fit = BoxFit.contain,
  });
  final ImageAssetStore store;
  final String assetRef;
  final BoxFit fit;
  @override
  State<StoredImage> createState() => _StoredImageState();
}

class _StoredImageState extends State<StoredImage> {
  late Future<Uint8List> bytes;
  @override
  void initState() {
    super.initState();
    bytes = widget.store.read(widget.assetRef);
  }

  @override
  void didUpdateWidget(StoredImage old) {
    super.didUpdateWidget(old);
    if (old.assetRef != widget.assetRef || old.store != widget.store) {
      bytes = widget.store.read(widget.assetRef);
    }
  }

  @override
  Widget build(BuildContext context) => FutureBuilder<Uint8List>(
    future: bytes,
    builder: (context, snapshot) {
      if (snapshot.hasError) {
        return const Center(
          child: Tooltip(
            message: '原图暂时无法读取；图库记录仍保留。',
            child: Icon(Icons.broken_image_outlined),
          ),
        );
      }
      if (!snapshot.hasData) {
        return const Center(
          child: SizedBox(
            width: 18,
            height: 18,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        );
      }
      return Image.memory(
        snapshot.data!,
        fit: widget.fit,
        gaplessPlayback: true,
        errorBuilder: (_, _, _) =>
            const Center(child: Icon(Icons.broken_image_outlined)),
      );
    },
  );
}
