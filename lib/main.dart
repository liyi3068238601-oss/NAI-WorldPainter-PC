import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';

import 'platform/desktop_lifecycle.dart';
import 'platform/storage_probe.dart';
import 'storage/platform_store.dart';
import 'prototype/workbench_controller.dart';
import 'generation/generation_runtime.dart';
import 'media/image_asset_store.dart';
import 'security/credential_vault.dart';
import 'security/credential_vault_probe.dart';

import 'prototype/workbench.dart';

Future<void> main(List<String> args) async {
  WidgetsFlutterBinding.ensureInitialized();
  if (await runWindowsCredentialProbe(args)) return;
  if (await runStorageProbe(args)) return;
  runApp(const WorkspaceBootstrap());
}

class WorkspaceBootstrap extends StatefulWidget {
  const WorkspaceBootstrap({super.key});
  @override
  State<WorkspaceBootstrap> createState() => _WorkspaceBootstrapState();
}

class _WorkspaceBootstrapState extends State<WorkspaceBootstrap> {
  late Future<WorkbenchController> workspace;
  @override
  void initState() {
    super.initState();
    DesktopLifecycle.install(() async => true);
    workspace = _load();
  }

  Future<WorkbenchController> _load() async {
    final store = await openWorkspaceStore();
    ImageAssetStore? assets;
    try {
      assets = await openImageAssetStore();
      final vault = createCredentialVault();
      final runtime = GenerationRuntime(assets: assets, vault: vault);
      return WorkbenchController(
        store: store,
        restored: await store.load(),
        assets: assets,
        vault: vault,
        generateImage: runtime.generate,
        cancelRequest: runtime.cancel,
      );
    } catch (_) {
      await assets?.close();
      await store.close();
      rethrow;
    }
  }

  @override
  Widget build(BuildContext context) => FutureBuilder<WorkbenchController>(
    future: workspace,
    builder: (context, snapshot) {
      if (snapshot.hasData) return WorldPainterApp(controller: snapshot.data!);
      return MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: ThemeData(
          brightness: Brightness.dark,
          fontFamily: 'NotoSansSC',
        ).copyWith(scaffoldBackgroundColor: const Color(0xFF0A0A0C)),
        home: Scaffold(
          body: Center(
            child: Padding(
              padding: const EdgeInsets.all(32),
              child: snapshot.hasError
                  ? Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(
                          Icons.storage_rounded,
                          size: 36,
                          color: Color(0xFFF5D57A),
                        ),
                        const SizedBox(height: 20),
                        const Text('无法打开本地工作区', style: TextStyle(fontSize: 20)),
                        const SizedBox(height: 12),
                        const Text(
                          '请检查存储目录权限、可用空间或数据库版本。\n现有数据未被重置。',
                          textAlign: TextAlign.center,
                        ),
                        const SizedBox(height: 20),
                        FilledButton(
                          onPressed: () => setState(() => workspace = _load()),
                          child: const Text('重试'),
                        ),
                      ],
                    )
                  : const Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        CircularProgressIndicator(color: Color(0xFFF5D57A)),
                        SizedBox(height: 20),
                        Text('正在恢复你的工作台…'),
                      ],
                    ),
            ),
          ),
        ),
      );
    },
  );
}

class WorldPainterApp extends StatefulWidget {
  const WorldPainterApp({super.key, this.controller});
  final WorkbenchController? controller;
  @override
  State<WorldPainterApp> createState() => _WorldPainterAppState();
}

class _WorldPainterAppState extends State<WorldPainterApp> {
  bool dark = true;
  bool reduceMotion = false;
  late final SemanticsHandle semantics;
  late final WorkbenchController controller;
  @override
  void initState() {
    super.initState();
    controller = widget.controller ?? WorkbenchController();
    dark = controller.darkTheme;
    reduceMotion = controller.reduceMotion;
    semantics = SemanticsBinding.instance.ensureSemantics();
    DesktopLifecycle.install(() async {
      try {
        await controller.closeStorage();
        return true;
      } catch (_) {
        return false;
      }
    });
  }

  @override
  void dispose() {
    semantics.dispose();
    DesktopLifecycle.uninstall();
    controller.dispose();
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
        controller: controller,
        dark: dark,
        reduceMotion: reduceMotion,
        onThemeChanged: () => setState(() {
          dark = !dark;
          controller.updatePreferences(darkTheme: dark);
        }),
        onMotionChanged: (value) => setState(() {
          reduceMotion = value;
          controller.updatePreferences(reduceMotion: value);
        }),
      ),
    );
  }
}
