import { readFileSync, writeFileSync } from "fs";
import { parse } from "yaml";

// Configuration
const OPENAPI_FILE = "better-auth.yaml";
const OUTPUT_FILE = "better-auth.paths.ts";
const DEFAULT_GROUP = "default";

// Valid HTTP methods to process
const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];

// CLI Arguments interface
interface CLIArgs {
    responseFields?: string[];
    requestFields?: string[];
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
 * Parses command line arguments
 */
function parseArgs(): CLIArgs {
    const args = process.argv.slice(2);
    const result: CLIArgs = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--response-fields' || arg === '-rf') {
            const nextArg = args[i + 1];
            if (nextArg && !nextArg.startsWith('-')) {
                try {
                    result.responseFields = JSON.parse(nextArg);
                    if (!Array.isArray(result.responseFields)) {
                        throw new Error('Response fields must be an array');
                    }
                    i++;
                } catch (error) {
                    console.error('❌ Invalid response fields format. Expected JSON array like ["email", "name"]');
                    process.exit(1);
                }
            }
        } else if (arg === '--request-fields' || arg === '-reqf') {
            const nextArg = args[i + 1];
            if (nextArg && !nextArg.startsWith('-')) {
                try {
                    result.requestFields = JSON.parse(nextArg);
                    if (!Array.isArray(result.requestFields)) {
                        throw new Error('Request fields must be an array');
                    }
                    i++;
                } catch (error) {
                    console.error('❌ Invalid request fields format. Expected JSON array like ["email", "password"]');
                    process.exit(1);
                }
            }
        }
    }

    return result;
}

/**
 * Main function
 */
function main(): void {
    try {
        const args = parseArgs();

        console.log(`🔄 Reading OpenAPI specification from: ${OPENAPI_FILE}`);
        const openApiContent = readFileSync(OPENAPI_FILE, "utf8");
        const openApi = parse(openApiContent);

        if (!openApi || !openApi.paths) {
            throw new Error("Invalid OpenAPI specification");
        }

        console.log(`✅ Successfully parsed OpenAPI specification`);

        // Extract basic group paths
        const groupPaths = extractGroupPaths(openApi);

        // Extract response field paths if specified
        let responseFieldPaths = { fieldPaths: {}, groupFieldPaths: {} };
        if (args.responseFields && args.responseFields.length > 0) {
            console.log(`🔍 Analyzing response fields: ${args.responseFields.join(', ')}`);
            responseFieldPaths = extractResponseFieldPaths(openApi, args.responseFields);
        }

        // Extract request field paths if specified
        let requestFieldPaths = { fieldPaths: {}, groupFieldPaths: {} };
        if (args.requestFields && args.requestFields.length > 0) {
            console.log(`🔍 Analyzing request fields: ${args.requestFields.join(', ')}`);
            requestFieldPaths = extractRequestFieldPaths(openApi, args.requestFields);
        }

        console.log(`⚒️ Generating improved TypeScript code...`);
        const generatedCode = generateImprovedCode(groupPaths, responseFieldPaths, requestFieldPaths);

        writeFileSync(OUTPUT_FILE, generatedCode);
        console.log(`✅ Successfully generated improved constants in: ${OUTPUT_FILE}`);
        console.log(`📦 Generated constants for ${Object.keys(groupPaths).length} categories`);

        // Log results
        console.log(`📊 Processing Statistics:`);
        for (const group in groupPaths) {
            console.log(`  "${group}": ${groupPaths[group].length} paths`);
        }

        if (args.responseFields) {
            console.log(`🎯 Generated response field constants for: ${args.responseFields.join(', ')}`);
        }

        if (args.requestFields) {
            console.log(`📝 Generated request field constants for: ${args.requestFields.join(', ')}`);
        }

    } catch (error) {
        console.error(`❌ Error generating paths:`, error);
        process.exit(1);
    }
}

// Run the main function
main();
