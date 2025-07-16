import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { parse } from "yaml";
import { Command } from "commander";
import chalk from "chalk";
import inquirer from "inquirer";
import path from "path";

// Configuration
const DEFAULT_OPENAPI_FILE = "./spec/better-auth.yaml";
const DEFAULT_OUTPUT_FILE = "./gen/better-auth.paths.ts";
const DEFAULT_GROUP = "default";

// Valid HTTP methods to process
const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];

/**
 * Resolves input file path - if no directory specified, uses ./spec/
 */
function resolveInputPath(inputPath: string): string {
    // If path contains directory separator, use as is
    if (inputPath.includes('/') || inputPath.includes('\\')) {
        return inputPath;
    }
    // Otherwise, prepend ./spec/
    return path.join('./spec', inputPath);
}

/**
 * Generates output filename from input filename
 */
function generateOutputFileName(inputPath: string): string {
    const fileName = path.basename(inputPath);
    const nameWithoutExt = fileName.replace(/\.[^/.]+$/, '');
    return `${nameWithoutExt}.path.ts`;
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
 * Converts group name to valid JavaScript identifier
 */
function toValidIdentifier(str: string): string {
    return str
        .toLowerCase()
        .replace(/[_-\s]+(.)/g, (_, char) => char.toUpperCase())
        .replace(/^(.)/, (char) => char.toLowerCase())
        .replace(/[^a-zA-Z0-9]/g, '');
}

/**
 * Converts string to PascalCase
 */
function toPascalCase(str: string): string {
    return str
        .toLowerCase()
        .replace(/[_-\s]+(.)/g, (_, char) => char.toUpperCase())
        .replace(/^(.)/, (char) => char.toUpperCase())
        .replace(/[^a-zA-Z0-9]/g, '');
}

/**
 * Finds common prefix in all paths of a group
 */
function findCommonPrefix(paths: string[]): string {
    if (!paths.length) return "";

    // Extract first segment after slash from each path
    const segments = paths.map(path => {
        const match = path.match(/^\/([^\/]+)/);
        return match ? match[1] : "";
    });

    // Check if all segments are the same
    const uniqueSegments = [...new Set(segments)];
    if (uniqueSegments.length === 1 && uniqueSegments[0]) {
        return uniqueSegments[0];
    }

    return "";
}

/**
 * Converts path to constant name with proper prefix removal
 */
function pathToConstantName(path: string, group: string): string {
    const validGroup = toValidIdentifier(group).toUpperCase();

    // Remove leading slash
    let processedPath = path.replace(/^\//, '');

    // Remove group prefix if it matches the beginning of the path
    const groupPrefix = group.toLowerCase();
    if (processedPath.startsWith(groupPrefix + '/')) {
        processedPath = processedPath.substring(groupPrefix.length + 1);
    } else if (processedPath.startsWith(groupPrefix + '-')) {
        processedPath = processedPath.substring(groupPrefix.length + 1);
    }

    // Replace path parameters {param} with param (remove braces)
    processedPath = processedPath.replace(/\{([^}]+)\}/g, '$1');

    // Replace non-alphanumeric characters with underscores
    processedPath = processedPath.replace(/[^a-zA-Z0-9]/g, '_');

    // Split by underscore and filter empty parts
    const parts = processedPath.split('_').filter(part => part.length > 0);

    // Convert all parts to uppercase
    const pathConstant = parts.map(part => part.toUpperCase()).join('_');

    return `${validGroup}_${pathConstant}`;
}

/**
 * Converts path to camelCase property name with prefix removal
 */
function pathToPropertyName(path: string, commonPrefix: string = ""): string {
    let processedPath = path;

    // Remove common prefix if present
    if (commonPrefix && path.startsWith(`/${commonPrefix}`)) {
        processedPath = path.substring(commonPrefix.length + 1); // Remove prefix and slash
    }

    return processedPath
        .replace(/^\//, '') // Remove leading slash
        .replace(/\{([^}]+)\}/g, 'By$1') // Convert {token} to ByToken
        .split('/')
        .map((segment, index) => {
            if (index === 0) return segment.toLowerCase();
            return segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase();
        })
        .join('')
        .replace(/[^a-zA-Z0-9]/g, '');
}

/**
 * Extracts and groups paths by their groups from OpenAPI specification
 */
function extractGroupPaths(openApi: any): Record<string, string[]> {
    const groupPaths: Record<string, Set<string>> = {};

    for (const path in openApi.paths) {
        const pathItem = openApi.paths[path];

        for (const method of HTTP_METHODS) {
            const operation = pathItem[method];
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
function findFieldsInSchema(schema: any, targetFields: string[]): string[] {
    const foundFields: string[] = [];

    if (!schema || typeof schema !== 'object') {
        return foundFields;
    }

    if (schema.properties && typeof schema.properties === 'object') {
        for (const field of targetFields) {
            if (field in schema.properties) {
                foundFields.push(field);
            }
        }

        for (const prop in schema.properties) {
            const nestedFields = findFieldsInSchema(schema.properties[prop], targetFields);
            foundFields.push(...nestedFields);
        }
    }

    if (schema.items) {
        const nestedFields = findFieldsInSchema(schema.items, targetFields);
        foundFields.push(...nestedFields);
    }

    const combinedSchemas = ['allOf', 'oneOf', 'anyOf'];
    for (const key of combinedSchemas) {
        if (schema[key] && Array.isArray(schema[key])) {
            for (const subSchema of schema[key]) {
                const nestedFields = findFieldsInSchema(subSchema, targetFields);
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
    openApi: any,
    targetFields: string[]
): {
    fieldPaths: Record<string, string[]>;
    groupFieldPaths: Record<string, Record<string, string[]>>;
} {
    const fieldPaths: Record<string, Set<string>> = {};
    const groupFieldPaths: Record<string, Record<string, Set<string>>> = {};

    for (const field of targetFields) {
        fieldPaths[field] = new Set();
        groupFieldPaths[field] = {};
    }

    for (const path in openApi.paths) {
        const pathItem = openApi.paths[path];

        for (const method of HTTP_METHODS) {
            const operation = pathItem[method];
            if (operation && operation.responses) {
                const groups = operation.tags || [DEFAULT_GROUP];

                for (const responseCode in operation.responses) {
                    const response = operation.responses[responseCode];
                    if (response.content) {
                        for (const mediaType in response.content) {
                            const mediaObj = response.content[mediaType];
                            if (mediaObj.schema) {
                                const foundFields = findFieldsInSchema(mediaObj.schema, targetFields);

                                for (const foundField of foundFields) {
                                    fieldPaths[foundField].add(path);

                                    for (const group of groups) {
                                        if (!groupFieldPaths[foundField][group]) {
                                            groupFieldPaths[foundField][group] = new Set();
                                        }
                                        groupFieldPaths[foundField][group].add(path);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Convert Sets to sorted arrays
    const result = {
        fieldPaths: {} as Record<string, string[]>,
        groupFieldPaths: {} as Record<string, Record<string, string[]>>
    };

    for (const field in fieldPaths) {
        result.fieldPaths[field] = Array.from(fieldPaths[field]).sort();
        result.groupFieldPaths[field] = {};
        for (const group in groupFieldPaths[field]) {
            result.groupFieldPaths[field][group] = Array.from(groupFieldPaths[field][group]).sort();
        }
    }

    return result;
}

/**
 * Extracts paths that have specific fields in their request bodies
 */
function extractRequestFieldPaths(
    openApi: any,
    targetFields: string[]
): {
    fieldPaths: Record<string, string[]>;
    groupFieldPaths: Record<string, Record<string, string[]>>;
} {
    const fieldPaths: Record<string, Set<string>> = {};
    const groupFieldPaths: Record<string, Record<string, Set<string>>> = {};

    for (const field of targetFields) {
        fieldPaths[field] = new Set();
        groupFieldPaths[field] = {};
    }

    for (const path in openApi.paths) {
        const pathItem = openApi.paths[path];

        for (const method of HTTP_METHODS) {
            const operation = pathItem[method];
            if (operation && operation.requestBody) {
                const groups = operation.tags || [DEFAULT_GROUP];

                if (operation.requestBody.content) {
                    for (const mediaType in operation.requestBody.content) {
                        const mediaObj = operation.requestBody.content[mediaType];
                        if (mediaObj.schema) {
                            const foundFields = findFieldsInSchema(mediaObj.schema, targetFields);

                            for (const foundField of foundFields) {
                                fieldPaths[foundField].add(path);

                                for (const group of groups) {
                                    if (!groupFieldPaths[foundField][group]) {
                                        groupFieldPaths[foundField][group] = new Set();
                                    }
                                    groupFieldPaths[foundField][group].add(path);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Convert Sets to sorted arrays
    const result = {
        fieldPaths: {} as Record<string, string[]>,
        groupFieldPaths: {} as Record<string, Record<string, string[]>>
    };

    for (const field in fieldPaths) {
        result.fieldPaths[field] = Array.from(fieldPaths[field]).sort();
        result.groupFieldPaths[field] = {};
        for (const group in groupFieldPaths[field]) {
            result.groupFieldPaths[field][group] = Array.from(groupFieldPaths[field][group]).sort();
        }
    }

    return result;
}

/**
 * Generates improved TypeScript code with individual path constants first
 */
function generateImprovedCode(
    groupPaths: Record<string, string[]>,
    responseFieldPaths: { fieldPaths: Record<string, string[]>; groupFieldPaths: Record<string, Record<string, string[]>> } = { fieldPaths: {}, groupFieldPaths: {} },
    requestFieldPaths: { fieldPaths: Record<string, string[]>; groupFieldPaths: Record<string, Record<string, string[]>> } = { fieldPaths: {}, groupFieldPaths: {} }
): string {
    let output = `// AUTO-GENERATED FILE. DO NOT EDIT.
  
  // Generated on: ${new Date().toISOString()}
  
  // This file provides reusable path constants organized by categories
  
  `;

    // Step 1: Create individual path constants with grouping comments
    output += `// ============================================\n`;
    output += `// INDIVIDUAL PATH CONSTANTS (Internal Use)\n`;
    output += `// ============================================\n\n`;

    const pathConstants: Record<string, string> = {};

    for (const group in groupPaths) {
        const groupDisplayName = group.charAt(0).toUpperCase() + group.slice(1);

        output += `// ${groupDisplayName} Paths\n`;

        for (const path of groupPaths[group]) {
            const constantName = pathToConstantName(path, group);
            pathConstants[path] = constantName;
            output += `const ${constantName} = "${path}";\n`;
        }

        output += `\n`;
    }

    // Step 2: Generate exported path arrays using PascalCase names
    output += `// ============================================\n`;
    output += `// EXPORTED PATH ARRAYS\n`;
    output += `// ============================================\n\n`;

    output += `// Individual category path arrays\n`;
    for (const group in groupPaths) {
        const pascalCaseName = toPascalCase(group) + 'Paths';

        output += `export const ${pascalCaseName} = [\n`;

        for (const path of groupPaths[group]) {
            const pathConstant = pathConstants[path];
            output += `  ${pathConstant},\n`;
        }

        output += `] as const;\n\n`;
    }

    // Combined all paths using the constants
    output += `// Combined list of all paths\n`;
    output += `export const AllPaths = [\n`;
    for (const group in groupPaths) {
        const pascalCaseName = toPascalCase(group) + 'Paths';
        output += `  ...${pascalCaseName},\n`;
    }
    output += `] as const;\n\n`;

    // Step 3: Generate field-based exports using arrays
    if (Object.keys(responseFieldPaths.fieldPaths).length > 0) {
        output += `// ============================================\n`;
        output += `// RESPONSE FIELD PATHS\n`;
        output += `// ============================================\n\n`;

        output += `// Paths that return specific fields in response (organized by field and group)\n`;
        output += `export const PathsReturningField = {\n`;

        for (const field in responseFieldPaths.groupFieldPaths) {
            output += `  ${field}: {\n`;

            for (const group in responseFieldPaths.groupFieldPaths[field]) {
                const validId = toValidIdentifier(group);
                output += `    ${validId}: [\n`;
                for (const path of responseFieldPaths.groupFieldPaths[field][group]) {
                    const pathConstant = pathConstants[path];
                    output += `      ${pathConstant},\n`;
                }
                output += `    ],\n`;
            }

            output += `  },\n`;
        }

        output += `} as const;\n\n`;

        // All paths returning field
        output += `// All paths that return specific fields in response (organized by field)\n`;
        output += `export const AllPathsReturningField = {\n`;

        for (const field in responseFieldPaths.fieldPaths) {
            output += `  ${field}: [\n`;
            for (const group in responseFieldPaths.groupFieldPaths[field]) {
                const validId = toValidIdentifier(group);
                output += `    ...PathsReturningField.${field}.${validId},\n`;
            }
            output += `  ],\n`;
        }

        output += `} as const;\n\n`;
    }

    // Request field paths
    if (Object.keys(requestFieldPaths.fieldPaths).length > 0) {
        output += `// ============================================\n`;
        output += `// REQUEST FIELD PATHS\n`;
        output += `// ============================================\n\n`;

        output += `// Paths that expect specific fields in request body (organized by field and group)\n`;
        output += `export const PathsExpectingField = {\n`;

        for (const field in requestFieldPaths.groupFieldPaths) {
            output += `  ${field}: {\n`;

            for (const group in requestFieldPaths.groupFieldPaths[field]) {
                const validId = toValidIdentifier(group);
                output += `    ${validId}: [\n`;
                for (const path of requestFieldPaths.groupFieldPaths[field][group]) {
                    const pathConstant = pathConstants[path];
                    output += `      ${pathConstant},\n`;
                }
                output += `    ],\n`;
            }

            output += `  },\n`;
        }

        output += `} as const;\n\n`;

        // All paths expecting field
        output += `// All paths that expect specific fields in request body (organized by field)\n`;
        output += `export const AllPathsExpectingField = {\n`;

        for (const field in requestFieldPaths.fieldPaths) {
            output += `  ${field}: [\n`;
            for (const group in requestFieldPaths.groupFieldPaths[field]) {
                const validId = toValidIdentifier(group);
                output += `    ...PathsExpectingField.${field}.${validId},\n`;
            }
            output += `  ],\n`;
        }

        output += `} as const;\n\n`;
    }

    // Step 4: Generate derived TypeScript types
    output += `// ============================================\n`;
    output += `// EXPORTED TYPES (Derived from Constants)\n`;
    output += `// ============================================\n\n`;

    // AllPaths type
    output += `// All paths type derived from AllPaths array\n`;
    output += `type AllPathsAsType = typeof AllPaths;\n`;
    output += `export type AllPaths = AllPathsAsType[number];\n\n`;

    // Individual group path types
    output += `// Individual group path types\n`;
    for (const group in groupPaths) {
        const pascalCaseName = toPascalCase(group) + 'Paths';
        output += `type ${pascalCaseName}AsType = typeof ${pascalCaseName};\n`;
        output += `export type ${pascalCaseName} = ${pascalCaseName}AsType[number];\n`;
    }
    output += `\n`;

    // ResponseFields and related types
    if (Object.keys(responseFieldPaths.fieldPaths).length > 0) {
        output += `// Response field types derived from PathsReturningField\n`;
        output += `type PathsReturningFieldAsType = typeof PathsReturningField;\n`;
        output += `export type ResponseFields = keyof PathsReturningFieldAsType;\n`;
        output += `export type ResponseFieldGroups<Field extends ResponseFields> =\n`;
        output += `  keyof PathsReturningFieldAsType[Field];\n`;
        output += `export type ResponseFieldGroupPaths<\n`;
        output += `  Field extends ResponseFields,\n`;
        output += `  Group extends keyof PathsReturningFieldAsType[Field],\n`;
        output += `> = PathsReturningFieldAsType[Field][Group];\n\n`;

        // AllPathsReturningField type
        output += `// All paths returning field type\n`;
        output += `type AllPathsReturningFieldAsType = typeof AllPathsReturningField;\n`;
        output += `export type AllPathsReturningField<Field extends ResponseFields> = AllPathsReturningFieldAsType[Field][number];\n\n`;
    }

    // RequestFields and related types  
    if (Object.keys(requestFieldPaths.fieldPaths).length > 0) {
        output += `// Request field types derived from PathsExpectingField\n`;
        output += `type PathsExpectingFieldAsType = typeof PathsExpectingField;\n`;
        output += `export type RequestFields = keyof PathsExpectingFieldAsType;\n`;
        output += `export type RequestFieldGroups<Field extends RequestFields> =\n`;
        output += `  keyof PathsExpectingFieldAsType[Field];\n`;
        output += `export type RequestFieldGroupPaths<\n`;
        output += `  Field extends RequestFields,\n`;
        output += `  Group extends keyof PathsExpectingFieldAsType[Field],\n`;
        output += `> = PathsExpectingFieldAsType[Field][Group];\n\n`;

        // AllPathsExpectingField type
        output += `// All paths expecting field type\n`;
        output += `type AllPathsExpectingFieldAsType = typeof AllPathsExpectingField;\n`;
        output += `export type AllPathsExpectingField<Field extends RequestFields> = AllPathsExpectingFieldAsType[Field][number];\n\n`;
    }


    return output;
}


/**
 * Setup commander.js CLI
 */
function setupCLI(): Command {
    const program = new Command();

    program
        .name('generate-types')
        .description(chalk.blue('Generate TypeScript path constants from OpenAPI specifications'))
        .version('1.0.0');

    program
        .option('-i, --input <file>', `Input OpenAPI file (default: ${DEFAULT_OPENAPI_FILE})`, DEFAULT_OPENAPI_FILE)
        .option('-o, --output <file>', `Output TypeScript file (default: auto-generated from input)`, DEFAULT_OUTPUT_FILE)
        .option('-rf, --response-fields <fields>', 'Response fields to analyze (JSON array)', parseJsonArray)
        .option('-reqf, --request-fields <fields>', 'Request fields to analyze (JSON array)', parseJsonArray)
        .option('--interactive', 'Run in interactive mode', false);

    program.on('--help', () => {
        console.log('');
        console.log(chalk.yellow('Examples:'));
        console.log('  $ generate-types                              # Interactive mode (default)');
        console.log('  $ generate-types -i my-api.yaml              # Output: ./gen/my-api.path.ts');
        console.log('  $ generate-types -i my-api.yaml -o custom.ts  # Output: ./gen/custom.ts');
        console.log('  $ generate-types --response-fields \'["email", "name"]\'');
        console.log('  $ generate-types --interactive                # Force interactive mode');
        console.log('');
        console.log(chalk.gray('File Path Rules:'));
        console.log(chalk.gray('  • Input files without path → ./spec/{filename}'));
        console.log(chalk.gray('  • Output files without path → ./gen/{filename}'));
        console.log(chalk.gray('  • Output filename auto-generated from input if not specified'));
        console.log(chalk.gray('  • Auto-generated format: {input-name}.path.ts'));
        console.log(chalk.gray('  • Paths with / or \\ are used as-is'));
        console.log('');
        console.log(chalk.gray('Note: Interactive mode is used by default when no arguments are provided.'));
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
    console.log(chalk.blue.bold('\n🎛️  Interactive Mode\n'));
    console.log(chalk.gray('Configure your OpenAPI type generation settings:\n'));

    const answers = await inquirer.prompt([
        {
            type: 'input',
            name: 'inputFile',
            message: 'OpenAPI input file:',
            default: 'better-auth.yaml',
            validate: (input) => input.trim() !== '' || 'Input file cannot be empty'
        },
        {
            type: 'confirm',
            name: 'useAutoOutput',
            message: 'Auto-generate output filename from input?',
            default: true
        },
        {
            type: 'input',
            name: 'outputFile',
            message: 'TypeScript output file:',
            when: (answers: any) => !answers.useAutoOutput,
            default: (answers: any) => generateOutputFileName(answers.inputFile),
            validate: (input) => input.trim() !== '' || 'Output file cannot be empty'
        },
        {
            type: 'confirm',
            name: 'includeResponseFields',
            message: 'Do you want to analyze response fields?',
            default: false
        },
        {
            type: 'input',
            name: 'responseFields',
            message: 'Enter response fields (comma-separated):',
            when: (answers) => answers.includeResponseFields,
            filter: (input) => input.split(',').map((field: string) => field.trim()).filter((field: string) => field !== ''),
            validate: (input) => input.length > 0 || 'Please enter at least one field'
        },
        {
            type: 'confirm',
            name: 'includeRequestFields',
            message: 'Do you want to analyze request fields?',
            default: false
        },
        {
            type: 'input',
            name: 'requestFields',
            message: 'Enter request fields (comma-separated):',
            when: (answers) => answers.includeRequestFields,
            filter: (input) => input.split(',').map((field: string) => field.trim()).filter((field: string) => field !== ''),
            validate: (input) => input.length > 0 || 'Please enter at least one field'
        }
    ]);

    const outputFile = answers.useAutoOutput
        ? generateOutputFileName(answers.inputFile)
        : answers.outputFile;

    return {
        inputFile: resolveInputPath(answers.inputFile),
        outputFile: resolveOutputPath(outputFile),
        responseFields: answers.responseFields,
        requestFields: answers.requestFields,
        interactive: true
    };
}

/**
 * Parse command line arguments
 */
async function parseArgs(): Promise<CLIArgs> {
    const program = setupCLI();
    program.parse();

    const options = program.opts();
    const hasRelevantArgs = options.input !== DEFAULT_OPENAPI_FILE ||
        options.output !== DEFAULT_OUTPUT_FILE ||
        options.responseFields ||
        options.requestFields;

    // Default to interactive mode if no relevant arguments are provided
    if (options.interactive || !hasRelevantArgs) {
        return await runInteractive();
    }

    const outputFile = options.output === DEFAULT_OUTPUT_FILE
        ? generateOutputFileName(options.input)
        : options.output;

    return {
        inputFile: resolveInputPath(options.input),
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

        // Use parsed args
        const inputFile = args.inputFile;
        const outputFile = args.outputFile;

        console.log(chalk.blue(`🔄 Reading OpenAPI specification from: ${chalk.cyan(inputFile)}`));
        const openApiContent = readFileSync(inputFile, "utf8");
        const openApi = parse(openApiContent);

        if (!openApi || !openApi.paths) {
            throw new Error("Invalid OpenAPI specification");
        }

        console.log(chalk.green(`✅ Successfully parsed OpenAPI specification`));

        // Extract basic group paths
        const groupPaths = extractGroupPaths(openApi);

        // Extract response field paths if specified
        let responseFieldPaths = { fieldPaths: {}, groupFieldPaths: {} };
        if (args.responseFields && args.responseFields.length > 0) {
            console.log(chalk.yellow(`🔍 Analyzing response fields: ${chalk.cyan(args.responseFields.join(', '))}`));
            responseFieldPaths = extractResponseFieldPaths(openApi, args.responseFields);
        }

        // Extract request field paths if specified
        let requestFieldPaths = { fieldPaths: {}, groupFieldPaths: {} };
        if (args.requestFields && args.requestFields.length > 0) {
            console.log(chalk.yellow(`🔍 Analyzing request fields: ${chalk.cyan(args.requestFields.join(', '))}`));
            requestFieldPaths = extractRequestFieldPaths(openApi, args.requestFields);
        }

        console.log(chalk.blue(`⚒️ Generating improved TypeScript code...`));
        const generatedCode = generateImprovedCode(groupPaths, responseFieldPaths, requestFieldPaths);

        // Ensure output directory exists
        const outputDir = path.dirname(outputFile);
        mkdirSync(outputDir, { recursive: true });

        writeFileSync(outputFile, generatedCode);
        console.log(chalk.green(`✅ Successfully generated improved constants in: ${chalk.cyan(outputFile)}`));
        console.log(chalk.magenta(`📦 Generated constants for ${chalk.bold(Object.keys(groupPaths).length)} categories`));

        // Log results
        console.log(chalk.blue(`📊 Processing Statistics:`));
        for (const group in groupPaths) {
            console.log(`  ${chalk.cyan(`"${group}"`)} ${chalk.gray('→')} ${chalk.yellow(groupPaths[group].length)} paths`);
        }

        if (args.responseFields) {
            console.log(chalk.green(`🎯 Generated response field constants for: ${chalk.cyan(args.responseFields.join(', '))}`));
        }

        if (args.requestFields) {
            console.log(chalk.green(`📝 Generated request field constants for: ${chalk.cyan(args.requestFields.join(', '))}`));
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
