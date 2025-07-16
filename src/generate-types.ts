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
 * Debug logging for field detection in nested structures
 */
function logFieldDetection(path: string, method: string, field: string, location: 'request' | 'response', nested: boolean = false) {
    const locationText = location === 'request' ? 'request body' : 'response';
    const nestedText = nested ? ' (nested)' : '';
    console.log(chalk.gray(`    📍 Found "${field}" in ${method.toUpperCase()} ${path} ${locationText}${nestedText}`));
}

/**
 * Recursively searches for fields in a schema object
 * Handles nested objects, optional fields, and empty objects that could contain target fields
 */
function findFieldsInSchema(
    schema: OpenAPI.SchemaObject | any,
    targetFields: string[],
    depth: number = 0,
    debug: boolean = false,
    context: { path?: string; method?: string; location?: 'request' | 'response' } = {}
): string[] {
    const foundFields: string[] = [];

    if (!schema || typeof schema !== 'object') {
        return foundFields;
    }

    // Prevent infinite recursion
    if (depth > 10) {
        return foundFields;
    }

    // Check direct properties
    if (schema.properties && typeof schema.properties === 'object') {
        for (const field of targetFields) {
            if (field in schema.properties) {
                foundFields.push(field);
                if (debug && context.path && context.method && context.location) {
                    logFieldDetection(context.path, context.method, field, context.location, depth > 0);
                }
            }
        }

        // Recursively check nested properties
        for (const prop in schema.properties) {
            const nestedFields = findFieldsInSchema(
                schema.properties[prop],
                targetFields,
                depth + 1,
                debug,
                context
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
            debug,
            context
        );
        foundFields.push(...nestedFields);
    }

    // Handle object schemas without explicit properties (could be dynamic objects)
    if (schema.type === 'object' && !schema.properties) {
        foundFields.push(...targetFields);
        if (debug && context.path && context.method && context.location) {
            for (const field of targetFields) {
                console.log(chalk.gray(`    🔍 Potential field "${field}" in ${context.method.toUpperCase()} ${context.path} ${context.location} (dynamic object)`));
            }
        }
    }

    // Handle additionalProperties (objects that can have additional dynamic properties)
    if (schema.additionalProperties) {
        if (typeof schema.additionalProperties === 'object') {
            const nestedFields = findFieldsInSchema(
                schema.additionalProperties,
                targetFields,
                depth + 1,
                debug,
                context
            );
            foundFields.push(...nestedFields);
        } else if (schema.additionalProperties === true) {
            foundFields.push(...targetFields);
            if (debug && context.path && context.method && context.location) {
                for (const field of targetFields) {
                    console.log(chalk.gray(`    ➕ Potential field "${field}" in ${context.method.toUpperCase()} ${context.path} ${context.location} (additional properties)`));
                }
            }
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
                    debug,
                    context
                );
                foundFields.push(...nestedFields);
            }
        }
    }

    // Handle patternProperties (objects with pattern-based property names)
    if (schema.patternProperties && typeof schema.patternProperties === 'object') {
        for (const pattern in schema.patternProperties) {
            const nestedFields = findFieldsInSchema(
                schema.patternProperties[pattern],
                targetFields,
                depth + 1,
                debug,
                context
            );
            foundFields.push(...nestedFields);
        }
    }

    // Handle discriminator schemas (for polymorphic objects)
    if (schema.discriminator && schema.discriminator.mapping) {
        foundFields.push(...targetFields);
        if (debug && context.path && context.method && context.location) {
            for (const field of targetFields) {
                console.log(chalk.gray(`    🔀 Potential field "${field}" in ${context.method.toUpperCase()} ${context.path} ${context.location} (discriminator)`));
            }
        }
    }

    // Handle free-form objects (objects with no schema restrictions)
    if (schema.type === 'object' && !schema.properties && !schema.additionalProperties && !schema.patternProperties) {
        foundFields.push(...targetFields);
        if (debug && context.path && context.method && context.location) {
            for (const field of targetFields) {
                console.log(chalk.gray(`    🆓 Potential field "${field}" in ${context.method.toUpperCase()} ${context.path} ${context.location} (free-form object)`));
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

    if (!openApi.paths) {
        return {
            fieldPaths: Object.fromEntries(targetFields.map(field => [field, []])),
            groupFieldPaths: Object.fromEntries(targetFields.map(field => [field, {}]))
        };
    }

    for (const path in openApi.paths) {
        const pathItem = openApi.paths[path];
        if (!pathItem) continue;

        for (const method of HTTP_METHODS) {
            const operation = (pathItem as any)[method]; // Type assertion for method access
            if (operation && operation.responses) {
                const groups = operation.tags || [DEFAULT_GROUP];

                for (const responseCode in operation.responses) {
                    const response = operation.responses[responseCode];
                    if (response && (response as any).content) {
                        for (const mediaType in (response as any).content) {
                            const mediaObj = (response as any).content[mediaType];
                            if (mediaObj.schema) {
                                const foundFields = findFieldsInSchema(mediaObj.schema, targetFields, 0, true, { path, method, location: 'response' });

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
    openApi: OpenAPI.Document,
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

    if (!openApi.paths) {
        return {
            fieldPaths: Object.fromEntries(targetFields.map(field => [field, []])),
            groupFieldPaths: Object.fromEntries(targetFields.map(field => [field, {}]))
        };
    }

    for (const path in openApi.paths) {
        const pathItem = openApi.paths[path];
        if (!pathItem) continue;

        for (const method of HTTP_METHODS) {
            const operation = (pathItem as any)[method]; // Type assertion for method access
            if (operation && operation.requestBody) {
                const groups = operation.tags || [DEFAULT_GROUP];

                if ((operation.requestBody as any).content) {
                    for (const mediaType in (operation.requestBody as any).content) {
                        const mediaObj = (operation.requestBody as any).content[mediaType];
                        if (mediaObj.schema) {
                            const foundFields = findFieldsInSchema(mediaObj.schema, targetFields, 0, true, { path, method, location: 'request' });

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

        output += `// Paths that have specific fields in response (organized by field and group)\n`;
        output += `export const PathsWithResponseField = {\n`;

        for (const field in responseFieldPaths.groupFieldPaths) {
            // Skip fields with no paths
            if (responseFieldPaths.fieldPaths[field].length === 0) {
                continue;
            }

            output += `  ${field}: {\n`;

            for (const group in responseFieldPaths.groupFieldPaths[field]) {
                // Skip empty groups
                if (responseFieldPaths.groupFieldPaths[field][group].length === 0) {
                    continue;
                }

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

        // All paths with response field
        output += `// All paths that have specific fields in response (organized by field)\n`;
        output += `export const AllPathsWithResponseField = {\n`;

        for (const field in responseFieldPaths.fieldPaths) {
            // Skip fields with no paths
            if (responseFieldPaths.fieldPaths[field].length === 0) {
                continue;
            }

            output += `  ${field}: [\n`;
            for (const group in responseFieldPaths.groupFieldPaths[field]) {
                // Skip empty groups
                if (responseFieldPaths.groupFieldPaths[field][group].length === 0) {
                    continue;
                }

                const validId = toValidIdentifier(group);
                output += `    ...PathsWithResponseField.${field}.${validId},\n`;
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

        output += `// Paths that have specific fields in request body (organized by field and group)\n`;
        output += `export const PathsWithRequestField = {\n`;

        for (const field in requestFieldPaths.groupFieldPaths) {
            // Skip fields with no paths
            if (requestFieldPaths.fieldPaths[field].length === 0) {
                continue;
            }

            output += `  ${field}: {\n`;

            for (const group in requestFieldPaths.groupFieldPaths[field]) {
                // Skip empty groups
                if (requestFieldPaths.groupFieldPaths[field][group].length === 0) {
                    continue;
                }

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

        // All paths with request field
        output += `// All paths that have specific fields in request body (organized by field)\n`;
        output += `export const AllPathsWithRequestField = {\n`;

        for (const field in requestFieldPaths.fieldPaths) {
            // Skip fields with no paths
            if (requestFieldPaths.fieldPaths[field].length === 0) {
                continue;
            }

            output += `  ${field}: [\n`;
            for (const group in requestFieldPaths.groupFieldPaths[field]) {
                // Skip empty groups
                if (requestFieldPaths.groupFieldPaths[field][group].length === 0) {
                    continue;
                }

                const validId = toValidIdentifier(group);
                output += `    ...PathsWithRequestField.${field}.${validId},\n`;
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
        output += `// Response field types derived from PathsWithResponseField\n`;
        output += `type PathsWithResponseFieldAsType = typeof PathsWithResponseField;\n`;
        output += `export type ResponseFields = keyof PathsWithResponseFieldAsType;\n`;
        output += `export type ResponseFieldGroups<Field extends ResponseFields> =\n`;
        output += `  keyof PathsWithResponseFieldAsType[Field];\n`;
        output += `export type ResponseFieldGroupPaths<\n`;
        output += `  Field extends ResponseFields,\n`;
        output += `  Group extends keyof PathsWithResponseFieldAsType[Field],\n`;
        output += `> = PathsWithResponseFieldAsType[Field][Group];\n\n`;

        // AllPathsWithResponseField type
        output += `// All paths with response field type\n`;
        output += `type AllPathsWithResponseFieldAsType = typeof AllPathsWithResponseField;\n`;
        output += `export type AllPathsWithResponseField<Field extends ResponseFields> = AllPathsWithResponseFieldAsType[Field][number];\n\n`;
    }

    // RequestFields and related types  
    if (Object.keys(requestFieldPaths.fieldPaths).length > 0) {
        output += `// Request field types derived from PathsWithRequestField\n`;
        output += `type PathsWithRequestFieldAsType = typeof PathsWithRequestField;\n`;
        output += `export type RequestFields = keyof PathsWithRequestFieldAsType;\n`;
        output += `export type RequestFieldGroups<Field extends RequestFields> =\n`;
        output += `  keyof PathsWithRequestFieldAsType[Field];\n`;
        output += `export type RequestFieldGroupPaths<\n`;
        output += `  Field extends RequestFields,\n`;
        output += `  Group extends keyof PathsWithRequestFieldAsType[Field],\n`;
        output += `> = PathsWithRequestFieldAsType[Field][Group];\n\n`;

        // AllPathsWithRequestField type
        output += `// All paths with request field type\n`;
        output += `type AllPathsWithRequestFieldAsType = typeof AllPathsWithRequestField;\n`;
        output += `export type AllPathsWithRequestField<Field extends RequestFields> = AllPathsWithRequestFieldAsType[Field][number];\n\n`;
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
        .option('-i, --input <file>', `Input OpenAPI file name (no .yaml extension needed, default: ${DEFAULT_OPENAPI_FILE})`, DEFAULT_OPENAPI_FILE)
        .option('-o, --output <file>', `Output TypeScript file (default: auto-generated from input)`)
        .option('-rf, --response-fields <fields>', 'Response fields to analyze (JSON array)', parseJsonArray)
        .option('-reqf, --request-fields <fields>', 'Request fields to analyze (JSON array)', parseJsonArray)
        .option('--interactive', 'Run in interactive mode', false);

    program.on('--help', () => {
        console.log('');
        console.log(chalk.yellow('Examples:'));
        console.log('  $ generate-types                              # Interactive mode (default)');
        console.log('  $ generate-types -i my-api                   # Output: ./gen/my-api.path.ts');
        console.log('  $ generate-types -i my-api -o custom.ts      # Output: ./gen/custom.ts');
        console.log('  $ generate-types -i my-api --response-fields \'["email", "name"]\'');
        console.log('  $ generate-types -i my-api --request-fields \'["password", "token"]\'');
        console.log('  $ generate-types --interactive                # Force interactive mode');
        console.log('');
        console.log(chalk.gray('File Path Rules:'));
        console.log(chalk.gray('  • Input files: just filename (no .yaml extension needed)'));
        console.log(chalk.gray('  • Input files without path → ./spec/{filename}.yaml'));
        console.log(chalk.gray('  • Output files without path → ./gen/{filename}'));
        console.log(chalk.gray('  • Output filename auto-generated from input if not specified'));
        console.log(chalk.gray('  • Auto-generated format: {input-name}.path.ts'));
        console.log(chalk.gray('  • Paths with / or \\ are used as-is'));
        console.log('');
        console.log(chalk.gray('Interactive Mode:'));
        console.log(chalk.gray('  • No confirmation prompts - just direct input'));
        console.log(chalk.gray('  • Leave fields empty to skip analysis'));
        console.log(chalk.gray('  • Displays equivalent command for reuse'));
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

    // Add .yaml extension if not present
    const inputFileName = answers.inputFile.endsWith('.yaml') ? answers.inputFile : `${answers.inputFile}.yaml`;

    const outputFile = answers.outputFile.trim() === ''
        ? generateOutputFileName(inputFileName)
        : answers.outputFile;

    const result = {
        inputFile: resolveInputPath(inputFileName),
        outputFile: resolveOutputPath(outputFile),
        responseFields: answers.responseFields.length > 0 ? answers.responseFields : undefined,
        requestFields: answers.requestFields.length > 0 ? answers.requestFields : undefined,
        interactive: true
    };

    // Print the equivalent command for reuse
    console.log(chalk.blue('\n📋 Equivalent command for reuse:'));
    let command = `generate-types -i ${answers.inputFile}`;

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

    // Add .yaml extension if not present for command line input
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

        // Use parsed args
        const inputFile = args.inputFile;
        const outputFile = args.outputFile;

        console.log(chalk.blue(`🔄 Reading OpenAPI specification from: ${chalk.cyan(inputFile)}`));

        // Use Scalar's OpenAPI parser to bundle and load the spec
        const bundleResult = await bundle(inputFile, {
            plugins: [readFiles()],
            treeShake: false // Keep all parts of the specification
        });

        if (!bundleResult) {
            throw new Error("Failed to bundle OpenAPI specification");
        }

        console.log(chalk.green(`✅ Successfully loaded OpenAPI specification`));

        // Validate the bundled specification (but allow fallback if validation fails)
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

                // Try to use the bundled result directly if it has the basic structure
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

            // Try to use the bundled result directly if it has the basic structure
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
