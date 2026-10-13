import 'image_asset_store_contract.dart';
import 'image_asset_validation.dart';

/// Collects exact, valid managed image references from JSON-like data.
///
/// It scans string values at every nesting level, so references in parameters,
/// sessions, parent links, candidate lists, and library source records remain
/// protected without depending on a particular snapshot schema. Malformed or
/// partial references are ignored and never authorize a removal.
Set<String> collectImageAssetReferences(Object? value) {
  final references = <String>{};
  final visited = Set<Object>.identity();

  void visit(Object? node) {
    if (node is String) {
      try {
        references.add(parseImageAssetRef(node).value);
      } on ImageAssetValidationException {
        // Only an exact managed reference is meaningful here.
      }
      return;
    }
    if (node is Map) {
      if (!visited.add(node)) return;
      for (final child in node.values) {
        visit(child);
      }
      return;
    }
    if (node is Iterable) {
      if (!visited.add(node)) return;
      for (final child in node) {
        visit(child);
      }
    }
  }

  visit(value);
  return Set<String>.unmodifiable(references);
}

/// A read-only snapshot of the relationship between indexed and stored assets.
///
/// The three categories can overlap: an unreferenced asset can also be
/// corrupt. This result never deletes data; callers must apply their own
/// transaction and lifecycle policy before removing any file.
class ImageAssetMaintenanceAudit {
  ImageAssetMaintenanceAudit({
    required Set<String> referencedRefs,
    required Set<String> storedRefs,
    required Set<String> missingReferences,
    required Set<String> corruptAssets,
    required Set<String> unusedAssets,
  }) : referencedRefs = Set<String>.unmodifiable(referencedRefs),
       storedRefs = Set<String>.unmodifiable(storedRefs),
       missingReferences = Set<String>.unmodifiable(missingReferences),
       corruptAssets = Set<String>.unmodifiable(corruptAssets),
       unusedAssets = Set<String>.unmodifiable(unusedAssets);

  final Set<String> referencedRefs;
  final Set<String> storedRefs;

  /// Snapshot references that could not be read because the asset is absent.
  final Set<String> missingReferences;

  /// References whose stored bytes or metadata fail the store's integrity checks.
  final Set<String> corruptAssets;

  /// Listed store assets with no exact reference in [referencedRefs].
  final Set<String> unusedAssets;
}

/// Audits a snapshot against a store without modifying either one.
///
/// Every discovered reference is read through [ImageAssetStore.read], which
/// verifies the stored content hash and format. Access errors are propagated;
/// only known missing and integrity failures are categorized in the result.
Future<ImageAssetMaintenanceAudit> auditImageAssets({
  required Object? snapshot,
  required ImageAssetStore store,
  ImageAssetMaintenance? maintenance,
}) async {
  final ImageAssetMaintenance? assetMaintenance =
      maintenance ??
      (store is ImageAssetMaintenance ? store as ImageAssetMaintenance : null);
  if (assetMaintenance == null) {
    throw ArgumentError.value(
      store,
      'store',
      'The image asset store does not support maintenance operations.',
    );
  }

  final referencedRefs = collectImageAssetReferences(snapshot);
  final listedRefs = await assetMaintenance.listAssets();
  final storedRefs = <String>{};
  for (final candidate in listedRefs) {
    try {
      storedRefs.add(parseImageAssetRef(candidate).value);
    } on ImageAssetValidationException {
      // An invalid store entry cannot authorize a read or later deletion.
    }
  }

  final missingReferences = <String>{};
  final corruptAssets = <String>{};
  final toVerify = <String>{...referencedRefs, ...storedRefs}.toList()..sort();
  for (final assetRef in toVerify) {
    try {
      await store.read(assetRef);
    } on ImageAssetNotFoundException {
      if (referencedRefs.contains(assetRef)) {
        missingReferences.add(assetRef);
      }
    } on ImageAssetIntegrityException {
      corruptAssets.add(assetRef);
    }
  }

  return ImageAssetMaintenanceAudit(
    referencedRefs: referencedRefs,
    storedRefs: storedRefs,
    missingReferences: missingReferences,
    corruptAssets: corruptAssets,
    unusedAssets: storedRefs.difference(referencedRefs),
  );
}
