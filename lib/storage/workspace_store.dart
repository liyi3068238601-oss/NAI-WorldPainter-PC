/// Revisioned persistence contract for the desktop workspace snapshot.
abstract interface class WorkspaceStore {
  /// Name shown by diagnostics and probes.
  String get label;

  /// Loads the latest committed snapshot, or `null` before the first save.
  Future<StoredWorkspace?> load();

  /// Atomically saves [data] if [expectedRevision] is still current.
  ///
  /// The first successful save uses expected revision 0 and returns revision 1.
  Future<int> save(Map<String, Object?> data, {required int expectedRevision});

  /// Releases the underlying database connection.
  Future<void> close();
}

/// A workspace snapshot and the revision that was committed with it.
class StoredWorkspace {
  const StoredWorkspace({required this.data, required this.revision});

  final Map<String, Object?> data;
  final int revision;
}

/// Thrown when a snapshot was based on an older workspace revision.
class WorkspaceConflictException implements Exception {
  const WorkspaceConflictException({
    required this.expectedRevision,
    required this.actualRevision,
  });

  final int expectedRevision;
  final int actualRevision;

  @override
  String toString() =>
      'WorkspaceConflictException: expected revision $expectedRevision, '
      'but the current revision is $actualRevision.';
}

/// Thrown when a workspace snapshot or database schema is malformed.
class WorkspaceFormatException implements Exception {
  const WorkspaceFormatException(this.message, {this.cause});

  final String message;
  final Object? cause;

  @override
  String toString() => cause == null
      ? 'WorkspaceFormatException: $message'
      : 'WorkspaceFormatException: $message ($cause)';
}
