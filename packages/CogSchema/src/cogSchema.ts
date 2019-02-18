#!/usr/bin/env node
/**
 * Copyright(c) Microsoft Corporation.All rights reserved.
 * Licensed under the MIT License.
 */
// tslint:disable:no-console
// tslint:disable:no-object-literal-type-assertion
import * as chalk from 'chalk';
import * as fs from 'fs-extra';
import * as glob from 'globby';
import * as path from 'path';
import * as process from 'process';
import * as program from 'commander';
import * as semver from 'semver';
import * as Validator from 'ajv';
let parser: any = require('json-schema-ref-parser');
let allof: any = require('json-schema-merge-allof');

// tslint:disable-next-line:no-let-requires no-require-imports
const pkg: IPackage = require('../package.json');
const requiredVersion: string = pkg.engines.node;
if (!semver.satisfies(process.version, requiredVersion)) {
    console.error(`Required node version ${requiredVersion} not satisfied with current version ${process.version}.`);
    process.exit(1);
}

program.Command.prototype.unknownOption = (flag: string): void => {
    console.error(chalk.default.redBright(`Unknown arguments: ${flag}`));
    program.outputHelp((str: string) => {
        console.error(chalk.default.redBright(str));
        return '';
    });
    process.exit(1);
};

program
    .version(pkg.version, '-v, --Version')
    .usage("[options] <fileRegex ...>")
    .option("-o, output <path>", "Output path and filename for unified schema.")
    .description(`Take JSON Schema files and merge them into a single schema file where $ref are included and allOf are merged.  Also supports component merging using $implements and oneOf, see readme.md for more information.`)
    .parse(process.argv);

let failed = false;
mergeSchemas();

async function mergeSchemas() {
    let schemaPaths = glob.sync(program.args);
    if (schemaPaths.length == 0) {
        program.help();
    }
    else {
        let definitions: any = {};
        let validator = new Validator();
        let schemaName = path.join(__dirname, "../src/cogSchema.schema");
        if (!await fs.pathExists(schemaName)) {
            // Recreate the local standalone schema by expanding meta-schema
            // If you change baseCogSchema.schema, just delete the old one and run this and it will build a new one which is then checked-in.
            let baseName = path.join(__dirname, "../src/baseCogSchema.schema");
            let schema = await fs.readJSON(baseName);
            schema.definitions.metaSchema = JSON.parse(await getURL(schema.$schema));
            walkJSON(schema, (elt) => {
                if (elt.$ref) {
                    elt.$ref = "#/definitions/metaSchema";
                    return true;
                }
                return false;
            });
            await fs.writeJSON(schemaName, schema, { spaces: 4 });
        }
        let metaSchema = await fs.readJSON(schemaName);
        validator.addSchema(metaSchema, 'cogSchema');
        for (let path of schemaPaths) {
            console.log(chalk.default.grey(`Parsing ${path}`));
            try {
                var schema = allof(await parser.dereference(path));
                delete schema.$schema;
                if (!validator.validate('cogSchema', schema)) {
                    for (let error of <Validator.ErrorObject[]>validator.errors) {
                        schemaError(error);
                    }
                }
                var filename = <string>path.split(/[\\\/]/).pop();
                var type = filename.substr(0, filename.lastIndexOf("."));
                if (!schema.type && !isUnionType(schema)) {
                    schema.type = "object";
                }
                definitions[type] = schema;
            } catch (e) {
                thrownError(e);
            }
        }
        fixDefinitionReferences(schema);
        findImplements(definitions);
        addTypeTitles(definitions);
        expandTypes(definitions);
        addStandardProperties(definitions, metaSchema);
        checkLG(definitions);
        let finalSchema = {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            title: "Component types",
            description: "These are all of the types that can be created by the loader.",
            oneOf: Object.keys(definitions)
                .filter((schemaName) => !isUnionType(definitions[schemaName]))
                .sort()
                .map((schemaName) => {
                    return {
                        title: schemaName,
                        description: definitions[schemaName].description || "",
                        $ref: "#/definitions/" + schemaName
                    };
                }),
            definitions: definitions
        };
        if (!program.output) {
            program.output = "app.schema";
        }
        if (!failed) {
            console.log("Writing " + program.output);
            await fs.writeJSON(program.output, finalSchema, { spaces: 4 });
        } else {
            console.log("Could not merge schemas");
        }
    }
}

function findImplements(definitions: any): void {
    for (let type in definitions) {
        walkJSON(definitions[type], (val: any) => {
            let done: any = val.$implements;
            if (done) {
                for (let unionName of val.$implements) {
                    if (definitions.hasOwnProperty(unionName)) {
                        let unionType = definitions[unionName];
                        if (!isUnionType(unionType)) {
                            badUnion(type, unionName);
                        } else {
                            if (!unionType.oneOf) {
                                unionType.oneOf = [];
                            }
                            unionType.oneOf.push({
                                // NOTE: This overrides any existing title to prevent namespace collisions
                                title: type,
                                description: definitions[type].description || type,
                                $ref: "#/definitions/" + type
                            });
                        }
                    } else {
                        missing(unionName)
                    }
                }
            }
            return done;
        });
    }
}

function addTypeTitles(definitions: any): void {
    walkJSON(definitions, (val) => {
        if (val.oneOf) {
            walkJSON(val.oneOf, (def) => {
                if (def.type) {
                    // NOTE: This overrides any existing title but prevents namespace collision
                    def.title = def.type;
                }
                return false;
            });
        }
        return false;
    });
}

function fixDefinitionReferences(definitions: any): void {
    for (let type in definitions) {
        walkJSON(definitions[type], (val: any) => {
            if (val.$ref) {
                let ref: string = val.$ref;
                if (ref.startsWith("#/definitions/")) {
                    val.$ref = "#/definitions/" + type + "/definitions" + ref.substr(ref.indexOf('/'));
                }
            }
            return false;
        });
    }
}

function expandTypes(definitions: any): void {
    walkJSON(definitions, (val) => {
        if (val.$type) {
            if (definitions.hasOwnProperty(val.$type)) {
                val.$ref = "#/definitions/" + val.$type;
            } else {
                missing(val.$type);
            }
        }
        return false;
    });
}

function addStandardProperties(definitions: any, cogSchema: any): void {
    for (let type in definitions) {
        let definition = definitions[type];
        if (!isUnionType(definition)) {
            // Reorder properties to put $ first.
            let props: any = {
                $type: cogSchema.definitions.type,
                $copy: cogSchema.definitions.copy,
                $id: cogSchema.definitions.id,
                $role: cogSchema.definitions.role
            };
            props.$type.const = type;
            if (definition.properties) {
                for (let prop in definition.properties) {
                    props[prop] = definition.properties[prop];
                }
            }
            definition.properties = props;
            definition.additionalProperties = false;
            definition.patternProperties = { "^\\$": { type: "string" } };
            if (definition.required) {
                let required = definition.required;
                definition.required = ["$type"];
                definition.anyOf = [
                    {
                        title: "Reference",
                        required: ["$ref"]
                    },
                    {
                        title: "Type",
                        required: required
                    }
                ];
            } else {
                definition.required = ["$type"];
            }
        }
    }
}

function checkLG(definitions: any): void {
    walkJSON(definitions, (elt, _obj, key) => {
        if (elt.$role === "lg") {
            if (!elt.type) {
                elt.type = "string";
            } else if (elt.type != "string") {
                badLG(<string>key);
            }
        }
        return false;
    });
}

function walkJSON(elt: any, fun: (val: any, obj?: any, key?: string) => boolean, obj?: any, key?: any): boolean {
    let done = fun(elt, obj, key);
    if (!done) {
        if (Array.isArray(elt)) {
            for (let val of elt) {
                done = walkJSON(val, fun);
                if (done) break;
            }
        }
        else if (typeof elt === 'object') {
            for (let val in elt) {
                done = walkJSON(elt[val], fun, elt, val);
                if (done) break;
            }
        }
    }
    return done;
}

function isUnionType(schema: any): boolean {
    return schema.$role === "unionType";
}

let missingTypes = new Set();
function missing(type: string): void {
    if (!missingTypes.has(type)) {
        console.log(chalk.default.redBright("Missing " + type + " schema file from merge."));
        missingTypes.add(type);
        failed = true;
    }
}

function badUnion(type: string, union: string): void {
    console.log(chalk.default.redBright(type + " $implements " + union + " which does not use oneOf."));
    failed = true;
}

function schemaError(error: Validator.ErrorObject): void {
    console.log(chalk.default.redBright(error.message || ""));
    failed = true;
}

function thrownError(error: Error): void {
    console.log(chalk.default.redBright(error.message || ""));
    failed = true;
}

function badLG(property: string): void {
    console.log(chalk.default.redBright(`${property} has a $role of lg and must be a string.`));
    failed = true;
}

async function getURL(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const http = require('http'),
            https = require('https');

        let client = http;

        if (url.toString().indexOf("https") === 0) {
            client = https;
        }

        client.get(url, (resp: any) => {
            let data = '';

            // A chunk of data has been recieved.
            resp.on('data', (chunk: any) => {
                data += chunk;
            });

            // The whole response has been received. Print out the result.
            resp.on('end', () => {
                resolve(data);
            });

        }).on("error", (err: any) => {
            reject(err);
        });
    });
};

interface IPackage {
    version: string;
    engines: { node: string };
}

