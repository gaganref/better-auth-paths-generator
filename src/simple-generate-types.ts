import { writeFileSync, mkdirSync } from "fs";
import { validate, dereference, bundle } from "@scalar/openapi-parser";
import { readFiles } from "@scalar/openapi-parser/plugins";
import { Command } from "commander";
import chalk from "chalk";
import inquirer from "inquirer";
import path from "path";
import type { OpenAPI } from "@scalar/openapi-types";

// Configuration
const DEFAULT_OPENAPI_FILE = "better-auth";
const DEFAULT_OUTPUT_FILE = ""; // Will be auto-generated from input
const DEFAULT_GROUP = "default";

// Valid HTTP methods to process
const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];

/**
 * Resolves input file path - if no directory specified, uses ./spec/
 * Automatically adds .yaml extension if not present
 */
function resolveInputPath(inputPath: string): string {
    // Add .yaml extension if not present
    let processedPath = inputPath.endsWith('.yaml') ? inputPath : `${inputPath}.yaml`;

    // If path contains directory separator, use as is
    if (processedPath.includes('/') || processedPath.includes('\\')) {
        return processedPath;
    }
    // Otherwise, prepend ./spec/
    return path.join('./spec', processedPath);
}

/**
 * Generates output filename from input filename
 */
function generateOutputFileName(inputPath: string): string {
    const fileName = path.basename(inputPath);
    const nameWithoutExt = fileName.replace(/\.[^/.]+$/, '');
    return `simple-${nameWithoutExt}.path.ts`;
}

/**
 * Resolves output file path - if no directory specified, uses ./gen/
 */
function resolveOutputPath(outputPath: string): string {
    // If path contains directory separator, use as is
    if (outputPath.includes('/') || outputPath.includes('\\')) {
        return outputPath;
    }
    // Otherwise, prepend ./gen/
    return path.join('./gen', outputPath);
}

// CLI Arguments interface
interface CLIArgs {
    inputFile: string;
    outputFile: string;
    responseFields?: string[];
    requestFields?: string[];
    interactive?: boolean;
}

/**
 * Converts string to camelCase (preserves existing camelCase)
 */
function toCamelCase(str: string): string {
    // If the string is already camelCase, return as is
    if (/^[a-z][a-zA-Z0-9]*$/.test(str)) {
        return str;
    }

    return str
        .replace(/[_-\s]+(.)/g, (_, char) => char.toUpperCase())
        .replace(/^(.)/, (char) => char.toLowerCase())
        .replace(/[^a-zA-Z0-9]/g, '');
}

/**
 * Extracts and groups paths by their groups from OpenAPI specification
 */
function extractGroupPaths(openApi: OpenAPI.Document): Record<string, string[]> {
    const groupPaths: Record<string, Set<string>> = {};

    if (!openApi.paths) {
        return {};
    }

    for (const path in openApi.paths) {
        const pathItem = openApi.paths[path];
        if (!pathItem) continue;

        for (const method of HTTP_METHODS) {
            const operation = (pathItem as any)[method]; // Type assertion for method access
            if (operation) {
                if (operation.tags && Array.isArray(operation.tags) && operation.tags.length > 0) {
                    for (const group of operation.tags) {
                        if (!groupPaths[group]) {
                            groupPaths[group] = new Set();
                        }
                        groupPaths[group].add(path);
                    }
                } else {
                    if (!groupPaths[DEFAULT_GROUP]) {
                        groupPaths[DEFAULT_GROUP] = new Set();
                    }
                    groupPaths[DEFAULT_GROUP].add(path);
                }
            }
        }
    }

    // Convert Sets to sorted arrays
    const result: Record<string, string[]> = {};
    for (const group in groupPaths) {
        result[group] = Array.from(groupPaths[group]).sort();
    }
    return result;
}

/**
 * Recursively searches for fields in a schema object
 */
function findFieldsInSchema(
    schema: OpenAPI.SchemaObject | any,
    targetFields: string[],
    depth: number = 0,
    openApiDoc?: OpenAPI.Document
): string[] {
    const foundFields: string[] = [];

    if (!schema || typeof schema !== 'object') {
        return foundFields;
    }

    // Prevent infinite recursion
    if (depth > 10) {
        return foundFields;
    }

    // Handle $ref references
    if (schema.$ref && openApiDoc) {
        try {
            const refPath = schema.$ref.replace('#/', '').split('/');
            let resolvedSchema = openApiDoc as any;

            for (const segment of refPath) {
                resolvedSchema = resolvedSchema[segment];
                if (!resolvedSchema) {
                    break;
                }
            }

            if (resolvedSchema) {
                const nestedFields = findFieldsInSchema(
                    resolvedSchema,
                    targetFields,
                    depth + 1,
                    openApiDoc
                );
                foundFields.push(...nestedFields);
            }
        } catch (error) {
            // If reference resolution fails, continue with other checks
        }
    }

    // Check direct properties
    if (schema.properties && typeof schema.properties === 'object') {
        for (const field of targetFields) {
            if (field in schema.properties) {
                foundFields.push(field);
            }
        }

        // Recursively check nested properties
        for (const prop in schema.properties) {
            const nestedFields = findFieldsInSchema(
                schema.properties[prop],
                targetFields,
                depth + 1,
                openApiDoc
            );
            foundFields.push(...nestedFields);
        }
    }

    // Handle array items
    if (schema.items) {
        const nestedFields = findFieldsInSchema(
            schema.items,
            targetFields,
            depth + 1,
            openApiDoc
        );
        foundFields.push(...nestedFields);
    }

    // Handle object schemas without explicit properties (could be dynamic objects)
    if (schema.type === 'object' && !schema.properties) {
        foundFields.push(...targetFields);
    }

    // Handle additionalProperties
    if (schema.additionalProperties) {
        if (typeof schema.additionalProperties === 'object') {
            const nestedFields = findFieldsInSchema(
                schema.additionalProperties,
                targetFields,
                depth + 1,
                openApiDoc
            );
            foundFields.push(...nestedFields);
        } else if (schema.additionalProperties === true) {
            foundFields.push(...targetFields);
        }
    }

    // Handle combined schemas
    const combinedSchemas = ['allOf', 'oneOf', 'anyOf'];
    for (const key of combinedSchemas) {
        if (schema[key] && Array.isArray(schema[key])) {
            for (const subSchema of schema[key]) {
                const nestedFields = findFieldsInSchema(
                    subSchema,
                    targetFields,
                    depth + 1,
                    openApiDoc
                );
                foundFields.push(...nestedFields);
            }
        }
    }

    return [...new Set(foundFields)];
}

/**
 * Extracts paths that return specific fields in their responses
 */
function extractResponseFieldPaths(
    openApi: OpenAPI.Document,
    targetFields: string[]
): Record<string, string[]> {
    const fieldPaths: Record<string, Set<string>> = {};

    for (const field of targetFields) {
        fieldPaths[field] = new Set();
    }

    if (!openApi.paths) {
        return Object.fromEntries(targetFields.map(field => [field, []]));
    }

    for (const path in openApi.paths) {
        const pathItem = openApi.paths[path];
        if (!pathItem) continue;

        for (const method of HTTP_METHODS) {
            const operation = (pathItem as any)[method];
            if (operation && operation.responses) {
                for (const responseCode in operation.responses) {
                    const response = operation.responses[responseCode];
                    if (response && (response as any).content) {
                        for (const mediaType in (response as any).content) {
                            const mediaObj = (response as any).content[mediaType];
                            if (mediaObj.schema) {
                                const foundFields = findFieldsInSchema(mediaObj.schema, targetFields, 0, openApi);
                                for (const foundField of foundFields) {
                                    fieldPaths[foundField].add(path);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Convert Sets to sorted arrays
    const result: Record<string, string[]> = {};
    for (const field in fieldPaths) {
        result[field] = Array.from(fieldPaths[field]).sort();
    }
    return result;
}

/**
 * Extracts paths that have specific fields in their request bodies
 */
function extractRequestFieldPaths(
    openApi: OpenAPI.Document,
    targetFields: string[]
): Record<string, string[]> {
    const fieldPaths: Record<string, Set<string>> = {};

    for (const field of targetFields) {
        fieldPaths[field] = new Set();
    }

    if (!openApi.paths) {
        return Object.fromEntries(targetFields.map(field => [field, []]));
    }

    for (const path in openApi.paths) {
        const pathItem = openApi.paths[path];
        if (!pathItem) continue;

        for (const method of HTTP_METHODS) {
            const operation = (pathItem as any)[method];
            if (operation && operation.requestBody) {
                if ((operation.requestBody as any).content) {
                    for (const mediaType in (operation.requestBody as any).content) {
                        const mediaObj = (operation.requestBody as any).content[mediaType];
                        if (mediaObj.schema) {
                            const foundFields = findFieldsInSchema(mediaObj.schema, targetFields, 0, openApi);
                            for (const foundField of foundFields) {
                                fieldPaths[foundField].add(path);
                            }
                        }
                    }
                }
            }
        }
    }

    // Convert Sets to sorted arrays
    const result: Record<string, string[]> = {};
    for (const field in fieldPaths) {
        result[field] = Array.from(fieldPaths[field]).sort();
    }
    return result;
}

/**
 * Converts string to UPPER_CASE (handles camelCase properly)
 */
function toUpperCase(str: string): string {
    return str
        // Handle camelCase by adding underscores before uppercase letters
        .replace(/([a-z])([A-Z])/g, '$1_$2')
        // Handle kebab-case and snake_case
        .replace(/[_-\s]+(.)/g, '_$1')
        // Remove non-alphanumeric characters except underscores
        .replace(/[^a-zA-Z0-9_]/g, '')
        // Convert to uppercase
        .toUpperCase();
}

/**
 * Generates simple TypeScript code with arrays and sets
 */
function generateSimpleCode(
    groupPaths: Record<string, string[]>,
    responseFieldPaths: Record<string, string[]> = {},
    requestFieldPaths: Record<string, string[]> = {}
): string {
    let output = `// AUTO-GENERATED FILE. DO NOT EDIT.\n`;
    output += `// Generated on: ${new Date().toISOString()}\n\n`;

    // Store variable names for later use
    const groupPathVars: Record<string, { constName: string; setName: string }> = {};
    const responseFieldVars: Record<string, { constName: string; setName: string }> = {};
    const requestFieldVars: Record<string, { constName: string; setName: string }> = {};

    // Generate group path arrays
    if (Object.keys(groupPaths).length > 0) {
        output += `// Path arrays by group\n`;
        for (const group in groupPaths) {
            const constName = toUpperCase(group) + '_PATHS';
            const setName = toCamelCase(group) + 'Paths';
            groupPathVars[group] = { constName, setName };

            output += `export const ${constName} = [\n`;
            for (const path of groupPaths[group]) {
                output += `  '${path}',\n`;
            }
            output += `];\n\n`;
        }

        // Generate combined all paths
        output += `// All paths combined\n`;
        output += `export const ALL_PATHS = [\n`;
        for (const group in groupPaths) {
            const { constName } = groupPathVars[group];
            output += `  ...${constName},\n`;
        }
        output += `];\n\n`;
    }

    // Generate response field paths
    if (Object.keys(responseFieldPaths).length > 0) {
        output += `// Paths that return specific fields in response\n`;
        for (const field in responseFieldPaths) {
            if (responseFieldPaths[field].length > 0) {
                const constName = toUpperCase(field) + '_RESPONSE_PATHS';
                const setName = toCamelCase(field) + 'ResponsePaths';
                responseFieldVars[field] = { constName, setName };

                output += `export const ${constName} = [\n`;
                for (const path of responseFieldPaths[field]) {
                    output += `  '${path}',\n`;
                }
                output += `];\n\n`;
            }
        }
    }

    // Generate request field paths
    if (Object.keys(requestFieldPaths).length > 0) {
        output += `// Paths that accept specific fields in request\n`;
        for (const field in requestFieldPaths) {
            if (requestFieldPaths[field].length > 0) {
                const constName = toUpperCase(field) + '_REQUEST_PATHS';
                const setName = toCamelCase(field) + 'RequestPaths';
                requestFieldVars[field] = { constName, setName };

                output += `export const ${constName} = [\n`;
                for (const path of requestFieldPaths[field]) {
                    output += `  '${path}',\n`;
                }
                output += `];\n\n`;
            }
        }
    }

    // Generate all sets at the bottom
    output += `// Sets for fast lookup\n`;

    // Group path sets
    for (const group in groupPaths) {
        const { constName, setName } = groupPathVars[group];
        output += `export const ${setName} = new Set(${constName});\n`;
    }

    if (Object.keys(groupPaths).length > 0) {
        output += `export const allPaths = new Set(ALL_PATHS);\n`;
    }

    // Response field sets
    for (const field in responseFieldPaths) {
        if (responseFieldPaths[field].length > 0) {
            const { constName, setName } = responseFieldVars[field];
            output += `export const ${setName} = new Set(${constName});\n`;
        }
    }

    // Request field sets
    for (const field in requestFieldPaths) {
        if (requestFieldPaths[field].length > 0) {
            const { constName, setName } = requestFieldVars[field];
            output += `export const ${setName} = new Set(${constName});\n`;
        }
    }

    return output;
}

/**
 * Setup commander.js CLI
 */
function setupCLI(): Command {
    const program = new Command();

    program
        .name('simple-generate-types')
        .description(chalk.blue('Generate simple TypeScript path constants from OpenAPI specifications'))
        .version('1.0.0');

    program
        .option('-i, --input <file>', `Input OpenAPI file name (no .yaml extension needed, default: ${DEFAULT_OPENAPI_FILE})`, DEFAULT_OPENAPI_FILE)
        .option('-o, --output <file>', `Output TypeScript file (default: auto-generated from input)`)
        .option('-rf, --response-fields <fields>', 'Response fields to analyze (JSON array)', parseJsonArray)
        .option('-reqf, --request-fields <fields>', 'Request fields to analyze (JSON array)', parseJsonArray)
        .option('--interactive', 'Run in interactive mode', false);

    program.on('--help', () => {
        console.log('');
        console.log(chalk.yellow('Examples:'));
        console.log('  $ simple-generate-types                              # Interactive mode (default)');
        console.log('  $ simple-generate-types -i my-api                   # Output: ./gen/my-api.path.ts');
        console.log('  $ simple-generate-types -i my-api -o custom.ts      # Output: ./gen/custom.ts');
        console.log('  $ simple-generate-types -i my-api --response-fields \'["email", "name"]\'');
        console.log('  $ simple-generate-types -i my-api --request-fields \'["password", "token"]\'');
        console.log('  $ simple-generate-types --interactive                # Force interactive mode');
        console.log('');
        console.log(chalk.gray('Output Format:'));
        console.log(chalk.gray('  • Simple arrays: const emailPaths = [\'/path1\', \'/path2\'];'));
        console.log(chalk.gray('  • Fast lookup sets: const allEmailPaths = new Set(emailPaths);'));
        console.log(chalk.gray('  • Clean and readable output'));
        console.log('');
    });

    return program;
}

/**
 * Parse JSON array from command line
 */
function parseJsonArray(value: string): string[] {
    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) {
            throw new Error('Must be an array');
        }
        return parsed;
    } catch (error) {
        console.error(chalk.red('❌ Invalid JSON array format. Expected format: ["field1", "field2"]'));
        process.exit(1);
    }
}

/**
 * Run interactive mode
 */
async function runInteractive(): Promise<CLIArgs> {
    console.log(chalk.blue.bold('\n🎛️  Interactive Mode - Simple Generator\n'));
    console.log(chalk.gray('Configure your OpenAPI type generation settings:\n'));

    const answers = await inquirer.prompt([
        {
            type: 'input',
            name: 'inputFile',
            message: 'OpenAPI YAML file name (without .yaml extension):',
            default: 'better-auth',
            validate: (input) => input.trim() !== '' || 'Input file cannot be empty'
        },
        {
            type: 'input',
            name: 'outputFile',
            message: 'TypeScript output file name (leave empty for auto-generated):',
            default: ''
        },
        {
            type: 'input',
            name: 'responseFields',
            message: 'Response fields to analyze (comma-separated, leave empty to skip):',
            default: '',
            filter: (input) => input.trim() === '' ? [] : input.split(',').map((field: string) => field.trim()).filter((field: string) => field !== '')
        },
        {
            type: 'input',
            name: 'requestFields',
            message: 'Request fields to analyze (comma-separated, leave empty to skip):',
            default: '',
            filter: (input) => input.trim() === '' ? [] : input.split(',').map((field: string) => field.trim()).filter((field: string) => field !== '')
        }
    ]);

    const inputFileName = answers.inputFile.endsWith('.yaml') ? answers.inputFile : `${answers.inputFile}.yaml`;
    const outputFile = answers.outputFile.trim() === '' ? generateOutputFileName(inputFileName) : answers.outputFile;

    const result = {
        inputFile: resolveInputPath(inputFileName),
        outputFile: resolveOutputPath(outputFile),
        responseFields: answers.responseFields.length > 0 ? answers.responseFields : undefined,
        requestFields: answers.requestFields.length > 0 ? answers.requestFields : undefined,
        interactive: true
    };

    // Print the equivalent command for reuse
    console.log(chalk.blue('\n📋 Equivalent command for reuse:'));
    let command = `simple-generate-types -i ${answers.inputFile}`;

    if (answers.outputFile.trim() !== '') {
        command += ` -o ${answers.outputFile}`;
    }

    if (answers.responseFields.length > 0) {
        command += ` --response-fields '${JSON.stringify(answers.responseFields)}'`;
    }

    if (answers.requestFields.length > 0) {
        command += ` --request-fields '${JSON.stringify(answers.requestFields)}'`;
    }

    console.log(chalk.cyan(command));
    console.log('');

    return result;
}

/**
 * Parse command line arguments
 */
async function parseArgs(): Promise<CLIArgs> {
    const program = setupCLI();
    program.parse();

    const options = program.opts();
    const hasRelevantArgs = options.input !== DEFAULT_OPENAPI_FILE ||
        options.output ||
        options.responseFields ||
        options.requestFields;

    // Default to interactive mode if no relevant arguments are provided
    if (options.interactive || !hasRelevantArgs) {
        return await runInteractive();
    }

    const inputFileName = options.input.endsWith('.yaml') ? options.input : `${options.input}.yaml`;
    const outputFile = options.output || generateOutputFileName(inputFileName);

    return {
        inputFile: resolveInputPath(inputFileName),
        outputFile: resolveOutputPath(outputFile),
        responseFields: options.responseFields,
        requestFields: options.requestFields,
        interactive: false
    };
}

/**
 * Main function
 */
async function main(): Promise<void> {
    try {
        const args = await parseArgs();
        const inputFile = args.inputFile;
        const outputFile = args.outputFile;

        console.log(chalk.blue(`🔄 Reading OpenAPI specification from: ${chalk.cyan(inputFile)}`));

        // Use Scalar's OpenAPI parser to bundle and load the spec
        const bundleResult = await bundle(inputFile, {
            plugins: [readFiles()],
            treeShake: false
        });

        if (!bundleResult) {
            throw new Error("Failed to bundle OpenAPI specification");
        }

        console.log(chalk.green(`✅ Successfully loaded OpenAPI specification`));

        // Validate the bundled specification
        let openApi: OpenAPI.Document;

        try {
            const validateResult = await validate(bundleResult);

            if (validateResult.valid && validateResult.specification) {
                openApi = validateResult.specification;
                console.log(chalk.green(`✅ Successfully validated OpenAPI specification`));
            } else {
                console.log(chalk.yellow(`⚠️  Validation failed, attempting to use bundled result directly...`));
                if (validateResult.errors) {
                    for (const error of validateResult.errors) {
                        console.log(chalk.yellow(`  - ${error.message}`));
                    }
                }

                if (bundleResult && typeof bundleResult === 'object' && 'paths' in bundleResult) {
                    openApi = bundleResult as OpenAPI.Document;
                    console.log(chalk.green(`✅ Using bundled result (validation bypassed)`));
                } else {
                    console.error(chalk.red(`❌ Cannot use bundled result - missing required structure`));
                    throw new Error("Invalid OpenAPI specification");
                }
            }
        } catch (validationError) {
            console.log(chalk.yellow(`⚠️  Validation failed, attempting to use bundled result directly...`));
            console.log(chalk.yellow(`  - ${(validationError as Error).message}`));

            if (bundleResult && typeof bundleResult === 'object' && 'paths' in bundleResult) {
                openApi = bundleResult as OpenAPI.Document;
                console.log(chalk.green(`✅ Using bundled result (validation bypassed)`));
            } else {
                console.error(chalk.red(`❌ Cannot use bundled result - missing required structure`));
                throw new Error("Invalid OpenAPI specification");
            }
        }

        if (!openApi || !openApi.paths) {
            throw new Error("Invalid OpenAPI specification - missing paths");
        }

        // Try to dereference for better reference resolution
        try {
            console.log(chalk.blue(`🔄 Attempting to dereference OpenAPI specification...`));
            const dereferenceResult = await dereference(openApi);

            if (dereferenceResult.specification && dereferenceResult.specification.paths) {
                openApi = dereferenceResult.specification;
                console.log(chalk.green(`✅ Successfully dereferenced OpenAPI specification`));
            }
        } catch (dereferenceError) {
            console.log(chalk.yellow(`⚠️  Could not dereference all references, using validated version: ${(dereferenceError as Error).message}`));
        }

        // Extract basic group paths
        const groupPaths = extractGroupPaths(openApi);

        // Extract response field paths if specified
        let responseFieldPaths: Record<string, string[]> = {};
        if (args.responseFields && args.responseFields.length > 0) {
            console.log(chalk.yellow(`🔍 Analyzing response fields: ${chalk.cyan(args.responseFields.join(', '))}`));
            responseFieldPaths = extractResponseFieldPaths(openApi, args.responseFields);
        }

        // Extract request field paths if specified
        let requestFieldPaths: Record<string, string[]> = {};
        if (args.requestFields && args.requestFields.length > 0) {
            console.log(chalk.yellow(`🔍 Analyzing request fields: ${chalk.cyan(args.requestFields.join(', '))}`));
            requestFieldPaths = extractRequestFieldPaths(openApi, args.requestFields);
        }

        console.log(chalk.blue(`⚒️ Generating simple TypeScript code...`));
        const generatedCode = generateSimpleCode(groupPaths, responseFieldPaths, requestFieldPaths);

        // Ensure output directory exists
        const outputDir = path.dirname(outputFile);
        mkdirSync(outputDir, { recursive: true });

        writeFileSync(outputFile, generatedCode);
        console.log(chalk.green(`✅ Successfully generated simple constants in: ${chalk.cyan(outputFile)}`));
        console.log(chalk.magenta(`📦 Generated simple arrays and sets for ${chalk.bold(Object.keys(groupPaths).length)} categories`));

        // Log results
        console.log(chalk.blue(`📊 Processing Statistics:`));
        for (const group in groupPaths) {
            console.log(`  ${chalk.cyan(`"${group}"`)} ${chalk.gray('→')} ${chalk.yellow(groupPaths[group].length)} paths`);
        }

        if (args.responseFields) {
            console.log(chalk.green(`🎯 Generated response field arrays for: ${chalk.cyan(args.responseFields.join(', '))}`));
        }

        if (args.requestFields) {
            console.log(chalk.green(`📝 Generated request field arrays for: ${chalk.cyan(args.requestFields.join(', '))}`));
        }

    } catch (error) {
        console.error(chalk.red(`❌ Error generating paths:`), error);
        process.exit(1);
    }
}

// Run the main function
(async () => {
    await main();
})(); 