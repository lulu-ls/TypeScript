namespace ts {
    /**
     * Branded string for keeping track of when we've turned an ambiguous path
     * specified like "./blah" to an absolute path to an actual
     * tsconfig file, e.g. "/root/blah/tsconfig.json"
     */
    type ResolvedConfigFileName = string & { _isResolvedConfigFileName: never };

    const minimumDate = new Date(-8640000000000000);
    const maximumDate = new Date(8640000000000000);

    /**
     * A BuildContext tracks what's going on during the course of a build.
     *
     * Callers may invoke any number of build requests within the same context;
     * until the context is reset, each project will only be built at most once.
     *
     * Example: In a standard setup where project B depends on project A, and both are out of date,
     * a failed build of A will result in A remaining out of date. When we try to build
     * B, we should immediately bail instead of recomputing A's up-to-date status again.
     *
     * This also matters for performing fast (i.e. fake) downstream builds of projects
     * when their upstream .d.ts files haven't changed content (but have newer timestamps)
     */
    export interface BuildContext {
        options: BuildOptions;
        /**
         * Map from output file name to its pre-build timestamp
         */
        unchangedOutputs: FileMap<Date>;

        /**
         * Map from config file name to up-to-date status
         */
        projectStatus: FileMap<UpToDateStatus>;

        /**
         * Issue a verbose diagnostic message. No-ops when options.verbose is false.
         */
        verbose(diag: DiagnosticMessage, ...args: any[]): void;
    }

    type Mapper = ReturnType<typeof createDependencyMapper>;
    interface DependencyGraph {
        buildQueue: ResolvedConfigFileName[][];
        dependencyMap: Mapper;
    }

    interface BuildOptions {
        dry: boolean;
        force: boolean;
        verbose: boolean;
    }

    enum BuildResultFlags {
        None = 0,

        /**
         * No errors of any kind occurred during build
         */
        Success = 1 << 0,
        /**
         * None of the .d.ts files emitted by this build were
         * different from the existing files on disk
         */
        DeclarationOutputUnchanged = 1 << 1,

        ConfigFileErrors = 1 << 2,
        SyntaxErrors = 1 << 3,
        TypeErrors = 1 << 4,
        DeclarationEmitErrors = 1 << 5,

        AnyErrors = ConfigFileErrors | SyntaxErrors | TypeErrors | DeclarationEmitErrors
    }

    enum UpToDateStatusType {
        Unbuildable,
        UpToDate,
        /**
         * The project appears out of date because its upstream inputs are newer than its outputs,
         * but all of its outputs are actually newer than the previous identical outputs of its (.d.ts) inputs.
         * This means we can Pseudo-build (just touch timestamps), as if we had actually built this project.
         */
        UpToDateWithUpstreamTypes,
        OutputMissing,
        OutOfDateWithSelf,
        OutOfDateWithUpstream,
        UpstreamOutOfDate,
        UpstreamBlocked
    }

    type UpToDateStatus =
        | Status.Unbuildable
        | Status.UpToDate
        | Status.OutputMissing
        | Status.OutOfDateWithSelf
        | Status.OutOfDateWithUpstream
        | Status.UpstreamOutOfDate
        | Status.UpstreamBlocked;

    namespace Status {
        /**
         * The project can't be built at all in its current state. For example,
         * its config file cannot be parsed, or it has a syntax error or missing file
         */
        export interface Unbuildable {
            type: UpToDateStatusType.Unbuildable;
            reason: string;
        }

        /**
         * The project is up to date with respect to its inputs.
         * We track what the newest input file is.
         */
        export interface UpToDate {
            type: UpToDateStatusType.UpToDate | UpToDateStatusType.UpToDateWithUpstreamTypes;
            newestInputFileTime: Date;
            newestDeclarationFileContentChangedTime: Date;
            newestOutputFileTime: Date;
        }

        /**
         * One or more of the outputs of the project does not exist.
         */
        export interface OutputMissing {
            type: UpToDateStatusType.OutputMissing;
            /**
             * The name of the first output file that didn't exist
             */
            missingOutputFileName: string;
        }

        /**
         * One or more of the project's outputs is older than its newest input.
         */
        export interface OutOfDateWithSelf {
            type: UpToDateStatusType.OutOfDateWithSelf;
            outOfDateOutputFileName: string;
            newerInputFileName: string;
        }

        /**
         * This project depends on an out-of-date project, so shouldn't be built yet
         */
        export interface UpstreamOutOfDate {
            type: UpToDateStatusType.UpstreamOutOfDate;
            upstreamProjectName: string;
        }

        /**
         * This project depends an upstream project with build errors
         */
        export interface UpstreamBlocked {
            type: UpToDateStatusType.UpstreamBlocked;
            upstreamProjectName: string;
        }

        /**
         * One or more of the project's outputs is older than the newest output of
         * an upstream project.
         */
        export interface OutOfDateWithUpstream {
            type: UpToDateStatusType.OutOfDateWithUpstream;
            outOfDateOutputFileName: string;
            newerProjectName: string;
        }
    }

    interface FileMap<T> {
        setValue(fileName: string, value: T): void;
        getValue(fileName: string): T | never;
        getValueOrUndefined(fileName: string): T | undefined;
    }

    /**
     * A FileMap maintains a normalized-key to value relationship
     */
    function createFileMap<T>(): FileMap<T> {
        // tslint:disable-next-line:no-null-keyword
        const lookup: { [key: string]: T } = Object.create(/*prototype*/ null);

        return {
            setValue,
            getValue,
            getValueOrUndefined,
        };

        function setValue(fileName: string, value: T) {
            lookup[normalizePath(fileName)] = value;
        }

        function getValue(fileName: string): T | never {
            const f = normalizePath(fileName);
            if (f in lookup) {
                return lookup[f];
            }
            else {
                throw new Error(`No value corresponding to ${fileName} exists in this map`);
            }
        }

        function getValueOrUndefined(fileName: string): T | undefined {
            const f = normalizePath(fileName);
            if (f in lookup) {
                return lookup[f];
            }
            else {
                return undefined;
            }
        }
    }

    export function createDependencyMapper() {
        const childToParents: { [key: string]: string[] } = {};
        const parentToChildren: { [key: string]: string[] } = {};
        const allKeys: string[] = [];

        function addReference(childConfigFileName: string, parentConfigFileName: string): void {
            addEntry(childToParents, childConfigFileName, parentConfigFileName);
            addEntry(parentToChildren, parentConfigFileName, childConfigFileName);
        }

        function getReferencesTo(parentConfigFileName: string): string[] {
            return parentToChildren[normalizePath(parentConfigFileName)] || [];
        }

        function getReferencesOf(childConfigFileName: string): string[] {
            return childToParents[normalizePath(childConfigFileName)] || [];
        }

        function getKeys(): ReadonlyArray<string> {
            return allKeys;
        }

        function addEntry(mapToAddTo: typeof childToParents | typeof parentToChildren, key: string, element: string) {
            key = normalizePath(key);
            element = normalizePath(element);
            const arr = (mapToAddTo[key] = mapToAddTo[key] || []);
            if (arr.indexOf(element) < 0) {
                arr.push(element);
            }
            if (allKeys.indexOf(key) < 0) allKeys.push(key);
            if (allKeys.indexOf(element) < 0) allKeys.push(element);
        }

        return {
            addReference,
            getReferencesTo,
            getReferencesOf,
            getKeys
        };
    }

    function getOutputDeclarationFileName(inputFileName: string, configFile: ParsedCommandLine) {
        const relativePath = getRelativePathFromDirectory(rootDirOfOptions(configFile.options, configFile.options.configFilePath!), inputFileName, /*ignoreCase*/ true);
        const outputPath = resolvePath(configFile.options.declarationDir || configFile.options.outDir || getDirectoryPath(configFile.options.configFilePath!), relativePath);
        return changeExtension(outputPath, ".d.ts");
    }

    function getOutputJavaScriptFileName(inputFileName: string, configFile: ParsedCommandLine) {
        const relativePath = getRelativePathFromDirectory(rootDirOfOptions(configFile.options, configFile.options.configFilePath!), inputFileName, /*ignoreCase*/ true);
        const outputPath = resolvePath(configFile.options.outDir || getDirectoryPath(configFile.options.configFilePath!), relativePath);
        return changeExtension(outputPath, (fileExtensionIs(inputFileName, ".tsx") && configFile.options.jsx === JsxEmit.Preserve) ? ".jsx" : ".js");
    }

    function getOutputFileNames(inputFileName: string, configFile: ParsedCommandLine): ReadonlyArray<string> {
        if (configFile.options.outFile) {
            return emptyArray;
        }

        const outputs: string[] = [];
        outputs.push(getOutputJavaScriptFileName(inputFileName, configFile));
        if (configFile.options.declaration) {
            const dts = outputs.push(getOutputDeclarationFileName(inputFileName, configFile));
            if (configFile.options.declarationMap) {
                outputs.push(dts + ".map");
            }
        }
        return outputs;
    }

    function getOutFileOutputs(project: ParsedCommandLine): ReadonlyArray<string> {
        if (!project.options.outFile) {
            throw new Error("Assert - outFile must be set");
        }
        const outputs: string[] = [];
        outputs.push(project.options.outFile);
        if (project.options.declaration) {
            const dts = outputs.push(changeExtension(project.options.outFile, ".d.ts"));
            if (project.options.declarationMap) {
                outputs.push(dts + ".map");
            }
        }
        return outputs;
    }

    function rootDirOfOptions(opts: CompilerOptions, configFileName: string) {
        return opts.rootDir || getDirectoryPath(configFileName);
    }

    function createConfigFileCache(host: CompilerHost) {
        const cache = createFileMap<ParsedCommandLine>();
        const configParseHost = parseConfigHostFromCompilerHost(host);

        // TODO: Cache invalidation under --watch

        function parseConfigFile(configFilePath: ResolvedConfigFileName) {
            const sourceFile = host.getSourceFile(configFilePath, ScriptTarget.JSON) as JsonSourceFile;
            if (sourceFile === undefined) {
                return undefined;
            }
            const parsed = parseJsonSourceFileConfigFileContent(sourceFile, configParseHost, getDirectoryPath(configFilePath));
            parsed.options.configFilePath = configFilePath;
            cache.setValue(configFilePath, parsed);
            return parsed;
        }

        return {
            parseConfigFile
        };
    }

    function newer(date1: Date, date2: Date): Date {
        return date2 > date1 ? date2 : date1;
    }

    function isDeclarationFile(fileName: string) {
        return fileExtensionIs(fileName, ".d.ts");
    }

    export function createBuildContext(options: BuildOptions, reportDiagnostic: DiagnosticReporter): BuildContext {
        const verboseDiag = options.verbose && reportDiagnostic;
        return {
            options,
            projectStatus: createFileMap(),
            unchangedOutputs: createFileMap(),
            verbose: verboseDiag ? (diag, ...args) => verboseDiag(createCompilerDiagnostic(diag, ...args)) : () => undefined
        };
    }

    export function performBuild(host: CompilerHost, reportDiagnostic: DiagnosticReporter, args: string[]) {
        let verbose = false;
        let dry = false;
        let force = false;
        let clean = false;

        const projects: string[] = [];
        for (const arg of args) {
            switch (arg.toLowerCase()) {
                case "-v":
                case "--verbose":
                    verbose = true;
                    continue;
                case "-d":
                case "--dry":
                    dry = true;
                    continue;
                case "-f":
                case "--force":
                    force = true;
                    continue;
                case "--clean":
                    clean = true;
                    continue;
            }
            // Not a flag, parse as filename
            addProject(arg);
        }

        if (projects.length === 0) {
            // tsc -b invoked with no extra arguments; act as if invoked with "tsc -b ."
            addProject(".");
        }

        const builder = createSolutionBuilder(host, reportDiagnostic, { verbose, dry, force });
        if (clean) {
            builder.cleanProjects(projects);
        }
        else {
            builder.buildProjects(projects);
        }

        function addProject(projectSpecification: string) {
            const fileName = resolvePath(host.getCurrentDirectory(), projectSpecification);
            const refPath = resolveProjectReferencePath(host, { path: fileName });
            if (!refPath) {
                reportDiagnostic(createCompilerDiagnostic(Diagnostics.File_0_does_not_exist, projectSpecification));
                return;
            }

            if (!host.fileExists(refPath)) {
                reportDiagnostic(createCompilerDiagnostic(Diagnostics.File_0_does_not_exist, fileName));
            }
            projects.push(refPath);

        }
    }

    export function createSolutionBuilder(host: CompilerHost, reportDiagnostic: DiagnosticReporter, defaultOptions: BuildOptions) {
        if (!host.getModifiedTime || !host.setModifiedTime) {
            throw new Error("Host must support timestamp APIs");
        }

        const configFileCache = createConfigFileCache(host);
        let context = createBuildContext(defaultOptions, reportDiagnostic);

        return {
            getUpToDateStatus,
            getUpToDateStatusOfFile,
            buildProjects,
            cleanProjects,
            resetBuildContext
        };

        function resetBuildContext(opts = defaultOptions) {
            context = createBuildContext(opts, reportDiagnostic);
        }

        function getUpToDateStatusOfFile(configFileName: ResolvedConfigFileName): UpToDateStatus {
            return getUpToDateStatus(configFileCache.parseConfigFile(configFileName));
        }

        function getUpToDateStatus(project: ParsedCommandLine | undefined): UpToDateStatus {
            if (project === undefined) {
                return { type: UpToDateStatusType.Unbuildable, reason: "File deleted mid-build" };
            }

            const prior = context.projectStatus.getValueOrUndefined(project.options.configFilePath!);
            if (prior !== undefined) {
                return prior;
            }
            const actual = getUpToDateStatusWorker(project);
            context.projectStatus.setValue(project.options.configFilePath!, actual);
            return actual;
        }

        function getAllProjectOutputs(project: ParsedCommandLine): ReadonlyArray<string> {
            if (project.options.outFile) {
                return getOutFileOutputs(project);
            }
            else {
                const outputs: string[] = [];
                for (const inputFile of project.fileNames) {
                    outputs.push(...getOutputFileNames(inputFile, project));
                }
                return outputs;
            }
        }

        function getUpToDateStatusWorker(project: ParsedCommandLine): UpToDateStatus {
            let newestInputFileName: string = undefined!;
            let newestInputFileTime = minimumDate;
            // Get timestamps of input files
            for (const inputFile of project.fileNames) {
                if (!host.fileExists(inputFile)) {
                    return {
                        type: UpToDateStatusType.Unbuildable,
                        reason: `${inputFile} does not exist`
                    };
                }

                const inputTime = host.getModifiedTime!(inputFile);
                if (inputTime > newestInputFileTime) {
                    newestInputFileName = inputFile;
                    newestInputFileTime = inputTime;
                }
            }

            // Collect the expected outputs of this project
            const outputs = getAllProjectOutputs(project);

            // Now see if all outputs are newer than the newest input
            let oldestOutputFileName: string | undefined;
            let oldestOutputFileTime: Date = maximumDate;
            let newestOutputFileTime: Date = minimumDate;
            let newestDeclarationFileContentChangedTime: Date = minimumDate;
            let missingOutputFileName: string | undefined;
            let isOutOfDateWithInputs = false;
            for (const output of outputs) {
                // Output is missing; can stop checking
                // Don't immediately return because we can still be upstream-blocked, which is a higher-priority status
                if (!host.fileExists(output)) {
                    missingOutputFileName = output;
                    break;
                }

                const outputTime = host.getModifiedTime!(output);
                if (outputTime < oldestOutputFileTime) {
                    oldestOutputFileTime = outputTime;
                    oldestOutputFileName = output;
                }

                // If an output is older than the newest input, we can stop checking
                // Don't immediately return because we can still be upstream-blocked, which is a higher-priority status
                if (outputTime < newestInputFileTime) {
                    isOutOfDateWithInputs = true;
                    break;
                }

                newestOutputFileTime = newer(newestOutputFileTime, outputTime);

                // Keep track of when the most recent time a .d.ts file was changed.
                // In addition to file timestamps, we also keep track of when a .d.ts file
                // had its file touched but not had its contents changed - this allows us
                // to skip a downstream typecheck
                if (isDeclarationFile(output)) {
                    const unchangedTime = context.unchangedOutputs.getValueOrUndefined(output);
                    if (unchangedTime !== undefined) {
                        newestDeclarationFileContentChangedTime = newer(unchangedTime, newestDeclarationFileContentChangedTime);
                    }
                    else {
                        newestDeclarationFileContentChangedTime = newer(newestDeclarationFileContentChangedTime, host.getModifiedTime!(output));
                    }
                }
            }

            let pseudoUpToDate = false;
            if (project.projectReferences) {
                for (const ref of project.projectReferences) {
                    const resolvedRef = resolveProjectReferencePath(host, ref) as ResolvedConfigFileName;
                    const refStatus = getUpToDateStatus(configFileCache.parseConfigFile(resolvedRef));

                    // An upstream project is blocked
                    if (refStatus.type === UpToDateStatusType.Unbuildable) {
                        return {
                            type: UpToDateStatusType.UpstreamBlocked,
                            upstreamProjectName: ref.path
                        };
                    }

                    // If the upstream project is out of date, then so are we (someone shouldn't have asked, though?)
                    if (refStatus.type !== UpToDateStatusType.UpToDate) {
                        return {
                            type: UpToDateStatusType.UpstreamOutOfDate,
                            upstreamProjectName: ref.path
                        };
                    }

                    // If the upstream project's newest file is older than our oldest output, we
                    // can't be out of date because of it
                    if (refStatus.newestInputFileTime <= oldestOutputFileTime) {
                        continue;
                    }

                    // If the upstream project has only change .d.ts files, and we've built
                    // *after* those files, then we're "psuedo up to date" and eligible for a fast rebuild
                    if (refStatus.newestDeclarationFileContentChangedTime <= oldestOutputFileTime) {
                        pseudoUpToDate = true;
                        continue;
                    }

                    // We have an output older than an upstream output - we are out of date
                    Debug.assert(oldestOutputFileName !== undefined, "Should have an oldest output filename here");
                    return {
                        type: UpToDateStatusType.OutOfDateWithUpstream,
                        outOfDateOutputFileName: oldestOutputFileName!,
                        newerProjectName: ref.path
                    };
                }
            }

            if (missingOutputFileName !== undefined) {
                return {
                    type: UpToDateStatusType.OutputMissing,
                    missingOutputFileName
                };
            }

            if (isOutOfDateWithInputs) {
                return {
                    type: UpToDateStatusType.OutOfDateWithSelf,
                    outOfDateOutputFileName: oldestOutputFileName!,
                    newerInputFileName: newestInputFileName
                };
            }

            // Up to date
            return {
                type: pseudoUpToDate ? UpToDateStatusType.UpToDateWithUpstreamTypes : UpToDateStatusType.UpToDate,
                newestDeclarationFileContentChangedTime,
                newestInputFileTime,
                newestOutputFileTime
            };
        }

        // TODO: Use the better algorithm
        function createDependencyGraph(roots: ResolvedConfigFileName[]): DependencyGraph {
            // This is a list of list of projects that need to be built.
            // The ordering here is "backwards", i.e. the first entry in the array is the last set of projects that need to be built;
            //   and the last entry is the first set of projects to be built.
            // Each subarray is effectively unordered.
            // We traverse the reference graph from each root, then "clean" the list by removing
            //   any entry that is duplicated to its right.
            const buildQueue: ResolvedConfigFileName[][] = [];
            const dependencyMap = createDependencyMapper();
            let buildQueuePosition = 0;
            for (const root of roots) {
                const config = configFileCache.parseConfigFile(root);
                if (config === undefined) {
                    reportDiagnostic(createCompilerDiagnostic(Diagnostics.File_0_does_not_exist, root));
                    continue;
                }
                enumerateReferences(normalizePath(root) as ResolvedConfigFileName, config);
            }
            removeDuplicatesFromBuildQueue(buildQueue);

            return {
                buildQueue,
                dependencyMap
            };

            function enumerateReferences(fileName: ResolvedConfigFileName, root: ParsedCommandLine): void {
                const myBuildLevel = buildQueue[buildQueuePosition] = buildQueue[buildQueuePosition] || [];
                if (myBuildLevel.indexOf(fileName) < 0) {
                    myBuildLevel.push(fileName);
                }

                const refs = root.projectReferences;
                if (refs === undefined) return;
                buildQueuePosition++;
                for (const ref of refs) {
                    const actualPath = resolveProjectReferencePath(host, ref) as ResolvedConfigFileName;
                    dependencyMap.addReference(fileName, actualPath);
                    const resolvedRef = configFileCache.parseConfigFile(actualPath);
                    if (resolvedRef === undefined) continue;
                    enumerateReferences(normalizePath(actualPath) as ResolvedConfigFileName, resolvedRef);
                }
                buildQueuePosition--;
            }

            /**
             * Removes entries from arrays which appear in later arrays.
             */
            function removeDuplicatesFromBuildQueue(queue: string[][]): void {
                // No need to check the last array
                for (let i = 0; i < queue.length - 1; i++) {
                    queue[i] = queue[i].filter(fn => !occursAfter(fn, i + 1));
                }

                function occursAfter(s: string, start: number) {
                    for (let i = start; i < queue.length; i++) {
                        if (queue[i].indexOf(s) >= 0) return true;
                    }
                    return false;
                }
            }
        }

        // TODO Accept parsedCommandLine instead?
        function buildSingleProject(proj: ResolvedConfigFileName): BuildResultFlags {
            if (context.options.dry) {
                reportDiagnostic(createCompilerDiagnostic(Diagnostics.Would_build_project_0, proj));
                return BuildResultFlags.Success;
            }

            context.verbose(Diagnostics.Building_project_0, proj);

            let resultFlags = BuildResultFlags.None;
            resultFlags |= BuildResultFlags.DeclarationOutputUnchanged;

            const configFile = configFileCache.parseConfigFile(proj);
            if (!configFile) {
                // Failed to read the config file
                resultFlags |= BuildResultFlags.ConfigFileErrors;
                context.projectStatus.setValue(proj, { type: UpToDateStatusType.Unbuildable, reason: "Config file errors" });
                return resultFlags;
            }

            if (configFile.fileNames.length === 0) {
                // Nothing to build - must be a solution file, basically
                return BuildResultFlags.None;
            }

            const programOptions: CreateProgramOptions = {
                projectReferences: configFile.projectReferences,
                host,
                rootNames: configFile.fileNames,
                options: configFile.options
            };
            const program = createProgram(programOptions);

            // Don't emit anything in the presence of syntactic errors or options diagnostics
            const syntaxDiagnostics = [...program.getOptionsDiagnostics(), ...program.getSyntacticDiagnostics()];
            if (syntaxDiagnostics.length) {
                resultFlags |= BuildResultFlags.SyntaxErrors;
                for (const diag of syntaxDiagnostics) {
                    reportDiagnostic(diag);
                }
                context.projectStatus.setValue(proj, { type: UpToDateStatusType.Unbuildable, reason: "Syntactic errors" });
                return resultFlags;
            }

            // Don't emit .d.ts if there are decl file errors
            if (program.getCompilerOptions().declaration) {
                const declDiagnostics = program.getDeclarationDiagnostics();
                if (declDiagnostics.length) {
                    resultFlags |= BuildResultFlags.DeclarationEmitErrors;
                    for (const diag of declDiagnostics) {
                        reportDiagnostic(diag);
                    }
                    context.projectStatus.setValue(proj, { type: UpToDateStatusType.Unbuildable, reason: "Declaration file errors" });
                    return resultFlags;
                }
            }

            const semanticDiagnostics = [...program.getSemanticDiagnostics()];
            if (semanticDiagnostics.length) {
                resultFlags |= BuildResultFlags.TypeErrors;
                for (const diag of semanticDiagnostics) {
                    reportDiagnostic(diag);
                }
                context.projectStatus.setValue(proj, { type: UpToDateStatusType.Unbuildable, reason: "Semantic errors" });
                return resultFlags;
            }

            let newestDeclarationFileContentChangedTime = minimumDate;
            program.emit(/*targetSourceFile*/ undefined, (fileName, content, writeBom, onError) => {
                let priorChangeTime: Date | undefined;

                if (isDeclarationFile(fileName) && host.fileExists(fileName)) {
                    if (host.readFile(fileName) === content) {
                        // Check for unchanged .d.ts files
                        resultFlags &= ~BuildResultFlags.DeclarationOutputUnchanged;
                        priorChangeTime = host.getModifiedTime && host.getModifiedTime(fileName);
                    }
                }

                host.writeFile(fileName, content, writeBom, onError, emptyArray);
                if (priorChangeTime !== undefined) {
                    newestDeclarationFileContentChangedTime = newer(priorChangeTime, newestDeclarationFileContentChangedTime);
                    context.unchangedOutputs.setValue(fileName, priorChangeTime);
                }
            });

            context.projectStatus.setValue(proj, { type: UpToDateStatusType.UpToDate, newestDeclarationFileContentChangedTime } as UpToDateStatus);
            return resultFlags;
        }

        function updateOutputTimestamps(proj: ParsedCommandLine) {
            if (context.options.dry) {
                reportDiagnostic(createCompilerDiagnostic(Diagnostics.Would_build_project_0, proj.options.configFilePath));
                return;
            }

            context.verbose(Diagnostics.Updating_output_timestamps_of_project_0, proj.options.configFilePath);
            const now = new Date();
            const outputs = getAllProjectOutputs(proj);
            let priorNewestUpdateTime = minimumDate;
            for (const file of outputs) {
                if (isDeclarationFile(file)) {
                    priorNewestUpdateTime = newer(priorNewestUpdateTime, host.getModifiedTime!(file));
                }
                host.setModifiedTime!(file, now);
            }

            context.projectStatus.setValue(proj.options.configFilePath!, { type: UpToDateStatusType.UpToDate, newestDeclarationFileContentChangedTime: priorNewestUpdateTime } as UpToDateStatus);
        }

        function getFilesToClean(configFileNames: ResolvedConfigFileName[]): string[] | undefined {
            const resolvedNames: ResolvedConfigFileName[] | undefined = resolveProjectNames(configFileNames);
            if (resolvedNames === undefined) return undefined;

            // Get the same graph for cleaning we'd use for building
            const graph = createDependencyGraph(resolvedNames);

            const filesToDelete: string[] = [];
            for (const level of graph.buildQueue) {
                for (const proj of level) {
                    const parsed = configFileCache.parseConfigFile(proj);
                    if (parsed === undefined) {
                        // File has gone missing; fine to ignore here
                        continue;
                    }
                    const outputs = getAllProjectOutputs(parsed);
                    for (const output of outputs) {
                        if (host.fileExists(output)) {
                            filesToDelete.push(output);
                        }
                    }
                }
            }
            return filesToDelete;
        }

        function cleanProjects(configFileNames: string[]) {
            const resolvedNames: ResolvedConfigFileName[] | undefined = resolveProjectNames(configFileNames);
            if (resolvedNames === undefined) return;

            const filesToDelete = getFilesToClean(resolvedNames);
            if (filesToDelete === undefined) {
                return;
            }

            if (context.options.dry) {
                reportDiagnostic(createCompilerDiagnostic(Diagnostics.Would_delete_the_following_files_Colon_0, filesToDelete.map(f => `\r\n * ${f}`).join("")));
            }
            else {
                if (!host.deleteFile) {
                    throw new Error("Host does not support deleting files");
                }

                for (const output of filesToDelete) {
                    host.deleteFile(output);
                }
            }
        }

        function resolveProjectNames(configFileNames: string[]): ResolvedConfigFileName[] | undefined {
            const resolvedNames: ResolvedConfigFileName[] = [];
            for (const name of configFileNames) {
                let fullPath = resolvePath(host.getCurrentDirectory(), name);
                if (host.fileExists(fullPath)) {
                    resolvedNames.push(fullPath as ResolvedConfigFileName);
                    continue;
                }
                fullPath = combinePaths(fullPath, "tsconfig.json");
                if (host.fileExists(fullPath)) {
                    resolvedNames.push(fullPath as ResolvedConfigFileName);
                    continue;
                }
                reportDiagnostic(createCompilerDiagnostic(Diagnostics.File_0_not_found, fullPath));
                return undefined;
            }
            return resolvedNames;
        }

        function buildProjects(configFileNames: string[]) {
            const resolvedNames: ResolvedConfigFileName[] | undefined = resolveProjectNames(configFileNames);
            if (resolvedNames === undefined) return;

            // Establish what needs to be built
            const graph = createDependencyGraph(resolvedNames);

            const queue = graph.buildQueue;
            reportBuildQueue(graph);

            let next: ResolvedConfigFileName | undefined;
            while (next = getNext()) {
                const proj = configFileCache.parseConfigFile(next);
                if (proj === undefined) {
                    break;
                }
                const status = getUpToDateStatus(proj);
                reportProjectStatus(next, status);

                const projName = proj.options.configFilePath;
                if (status.type === UpToDateStatusType.UpToDate && !context.options.force) {
                    // Up to date, skip
                    if (defaultOptions.dry) {
                        // In a dry build, inform the user of this fact
                        reportDiagnostic(createCompilerDiagnostic(Diagnostics.Project_0_is_up_to_date, projName));
                    }
                    continue;
                }

                if (status.type === UpToDateStatusType.UpToDateWithUpstreamTypes && !context.options.force) {
                    // Fake build
                    updateOutputTimestamps(proj);
                    continue;
                }

                if (status.type === UpToDateStatusType.UpstreamBlocked) {
                    context.verbose(Diagnostics.Skipping_build_of_project_0_because_its_upstream_project_1_has_errors, projName, status.upstreamProjectName);
                    continue;
                }

                buildSingleProject(next);
            }

            function getNext(): ResolvedConfigFileName | undefined {
                if (queue.length === 0) {
                    return undefined;
                }
                while (queue.length > 0) {
                    const last = queue[queue.length - 1];
                    if (last.length === 0) {
                        queue.pop();
                        continue;
                    }
                    return last.pop()!;
                }
                return undefined;
            }
        }

        /**
         * Report the build ordering inferred from the current project graph if we're in verbose mode
         */
        function reportBuildQueue(graph: DependencyGraph) {
            if (!context.options.verbose) return;

            const names: string[] = [];
            for (const level of graph.buildQueue) {
                for (const el of level) {
                    names.push(el);
                }
            }
            names.reverse();
            context.verbose(Diagnostics.Sorted_list_of_input_projects_Colon_0, names.map(s => "\r\n    * " + s).join(""));
        }

        /**
         * Report the up-to-date status of a project if we're in verbose mode
         */
        function reportProjectStatus(configFileName: string, status: UpToDateStatus) {
            if (!context.options.verbose) return;
            switch (status.type) {
                case UpToDateStatusType.OutOfDateWithSelf:
                    context.verbose(Diagnostics.Project_0_is_out_of_date_because_oldest_output_1_is_older_than_newest_input_2, configFileName, status.outOfDateOutputFileName, status.newerInputFileName);
                    return;
                case UpToDateStatusType.OutOfDateWithUpstream:
                    context.verbose(Diagnostics.Project_0_is_out_of_date_because_oldest_output_1_is_older_than_newest_input_2, configFileName, status.outOfDateOutputFileName, status.newerProjectName);
                    return;
                case UpToDateStatusType.OutputMissing:
                    context.verbose(Diagnostics.Project_0_is_out_of_date_because_output_file_1_does_not_exist, configFileName, status.missingOutputFileName);
                    return;
                case UpToDateStatusType.UpToDate:
                    if (status.newestInputFileTime !== undefined) {
                        context.verbose(Diagnostics.Project_0_is_up_to_date_because_newest_input_1_is_older_than_oldest_output_2, configFileName, status.newestInputFileTime, status.newestOutputFileTime);
                    }
                    else {
                        context.verbose(Diagnostics.Project_0_is_up_to_date_because_it_was_previously_built, configFileName);
                    }
                    return;
                case UpToDateStatusType.UpToDateWithUpstreamTypes:
                    context.verbose(Diagnostics.Project_0_is_up_to_date_with_its_upstream_types, configFileName);
                    return;
                case UpToDateStatusType.UpstreamOutOfDate:
                    context.verbose(Diagnostics.Project_0_is_up_to_date_with_its_upstream_types, configFileName);
                    return;
                case UpToDateStatusType.UpstreamBlocked:
                    context.verbose(Diagnostics.Project_0_can_t_be_built_because_it_depends_on_a_project_with_errors, configFileName);
                    return;
                case UpToDateStatusType.Unbuildable:
                    // TODO different error
                    context.verbose(Diagnostics.Project_0_can_t_be_built_because_it_depends_on_a_project_with_errors, configFileName);
                    return;
                default:
                    assertTypeIsNever(status);
            }
        }
    }
}
