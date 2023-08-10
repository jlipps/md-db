import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { LRUCache } from 'lru-cache'
import frontMatter from 'front-matter'
import { marked } from 'marked'
import Ajv, {JSONSchemaType, ValidateFunction} from 'ajv'
import {pluralize} from 'inflection'
import {glob} from 'glob'
import {fileNameToSlug} from './utils.js'
import * as _ from 'lodash-es'

const DEFAULT_MAX_CACHE_SIZE = 64 * 1024 * 1024
const ID_SCHEMA_TYPE = {type: ['string', 'integer']}

export interface MarkdownDBOpts {
    baseDir: string,
    maxCacheSize?: number,
}

export interface AddObjectTypeOpts {
    dirName?: string,
    relations?: Record<string, Relation>
}

export enum RelationType {
    HasMany = 'hasMany',
    HasOne = 'hasOne',
}

export interface Relation {
    relType: RelationType,
    objType: string,
    required?: boolean,
}

export type Relations = Record<string, Relation>

interface ObjectType {
    dirName: string,
    schemaValidator: ValidateFunction,
    relations: Relations,
}

export type ParsedObject<T> = T & {
    id: string,
    _html: string,
    _slug: string,
    _path: string,
    [key: string]: any // need this wildcard since we dynamically add relations
}

export class NoSuchObjectTypeError extends Error {
    constructor(type: string) {
        super(`Object of type '${type}' was not registered. Use addObjectType to do so`)
    }
}

export default class MarkdownDB {
    protected baseDir: string
    protected objectTypes: Record<string, ObjectType>
    protected cacheByFile: LRUCache<string, ParsedObject<Record<string, any>>>
    protected cacheById: Record<string, string>
    protected filenameCache: Record<string, string[]>
    protected objsInHydration: string[]
    protected ajv: Ajv

    constructor(opts: MarkdownDBOpts) {
        this.baseDir = opts.baseDir
        this.objectTypes = {}
        this.cacheByFile = new LRUCache({
            maxSize: opts.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE,
            sizeCalculation: (entry) => {
                return JSON.stringify(entry).length
            }
        })
        this.cacheById = {}
        this.filenameCache = {}
        this.ajv = new Ajv({allowUnionTypes: true})
        this.objsInHydration = []

    }

    addObjectType<T>(type: string, schema: JSONSchemaType<T>, opts: AddObjectTypeOpts = {}) {
        schema = _.cloneDeep(schema) // we modify schema below and don't want to mess up whatever the user passed in
        let dirName = opts.dirName ?? pluralize(type)
        if (schema.properties.id) {
            throw new Error(`Object schemas cannot include reserved key 'id'`)
        }
        schema.properties.id = ID_SCHEMA_TYPE
        schema.required.push('id')
        if (opts.relations) {
            for (const relName of Object.keys(opts.relations)) {
                const rel = opts.relations[relName]
                if (!Object.values(RelationType).includes(rel.relType)) {
                    throw new Error(`Don't know how to handle relation type '${rel.relType}'`)
                }
                if (schema.properties[relName]) {
                    throw new Error(`${rel.relType} relationship from '${type}' to '${rel.objType}' already ` +
                        `defined as '${relName}'. Don't define this yourself`)
                }
                let schemaRelType: Record<string, any> = ID_SCHEMA_TYPE
                if (rel.relType === RelationType.HasMany) {
                    schemaRelType = {type: 'array', items: ID_SCHEMA_TYPE}
                }
                schemaRelType.nullable = !!rel.required
                schema.properties[relName] = schemaRelType
            }
        }
        const compiledSchema = this.ajv.compile(schema)
        this.objectTypes[type] = {dirName, schemaValidator: compiledSchema, relations: opts.relations ?? {}}
    }

    async findById<T>(type: string, id: string|number): Promise<ParsedObject<T>> {
        let cachedObject = this.getCachedObjectById<T>(type, id)
        if (!cachedObject) {
            for (const mdFile of await this.getFilesForType(type)) {
                const obj = await this.getByFile<T>(type, mdFile)
                if (obj.id === id) {
                    cachedObject = obj
                    break
                }
            }
        }
        if (!cachedObject) {
            throw new Error(`Could not find '${type}' object with id '${id}'`)
        }
        return cachedObject
    }

    async find<T>(type: string, query: Record<string, any>): Promise<ParsedObject<T>[]> {
        const objects = await this.getAllByType<T>(type)
        const matchedObjects = []
        for (const obj of objects) {
            let match = true
            for (const queryKey of Object.keys(query)) {
                if (obj[queryKey] !== query[queryKey]) {
                    match = false
                }
            }
            if (match) {
                matchedObjects.push(obj)
            }
        }
        return matchedObjects
    }

    async getAllByType<T>(type: string): Promise<ParsedObject<T>[]> {
        const objects = []
        for (const mdFile of await this.getFilesForType(type)) {
            objects.push(await this.getByFile<T>(type, mdFile))
        }
        return objects
    }

    async getByFile<T>(type: string, mdFile: string): Promise<ParsedObject<T>> {
        let cachedObject = this.getCachedObjectByFile<T>(mdFile)
        if (!cachedObject) {
            if (!this.objectTypes[type]) {
                throw new NoSuchObjectTypeError(type)
            }
            const {schemaValidator} = this.objectTypes[type]
            const fileContent = await fs.readFile(mdFile, 'utf-8')
            const {attributes, body} = frontMatter(fileContent)
            const metadata = {...(attributes as Record<string, any>)}
            if (!schemaValidator(metadata)) {
                throw new Error(`Could not validate ${mdFile} against the provided schema. ` +
                                `Validation errors: ${JSON.stringify(schemaValidator.errors)}`)
            }
            const {id} = metadata
            if (!id) {
                throw new Error(`'${type}' object at ${mdFile} did not have id attribute`)
            }
            const _html = marked.parse(body, {mangle: false, headerIds: false})
            cachedObject = {...(metadata as T), id, _html, _slug: fileNameToSlug(mdFile), _path: mdFile}
            await this.hydrateRelations(type, cachedObject)
            this.cacheByFile.set(mdFile, cachedObject)
        }
        return cachedObject
    }

    private async hydrateRelations(type: string, object: ParsedObject<any>) {
        if (!this.objectTypes[type]) {
            throw new NoSuchObjectTypeError(type)
        }

        const hydrationKey = `${type}-${object.id}`
        if (this.objsInHydration.includes(hydrationKey)) {
            // short circuit if we are already hydrating this object to avoid infinite recursion
            return
        }
        this.objsInHydration.push(hydrationKey)

        const rels = this.objectTypes[type].relations
        for (const relName of Object.keys(rels)) {
            if (!object[relName]) {
                continue
            }
            const rel = rels[relName]
            if (rel.relType === RelationType.HasMany) {
                const newItems = []
                for (const oldItem of object[relName]) {
                    // these are the ids
                    newItems.push(await this.findById(rel.objType, oldItem))
                }
                object[relName] = newItems
            } else if (rel.relType === RelationType.HasOne) {
                object[relName] = await this.findById(rel.objType, object[relName])
            } else {
                throw new Error(`Can't hydrate relations of type ${rel.relType}`)
            }
        }
    }

    private getCachedObjectByFile<T>(file: string): ParsedObject<T> | undefined {
        const cachedObject = this.cacheByFile.get(file)
        if (cachedObject) {
            return cachedObject as ParsedObject<T>
        }
    }

    private getCachedObjectById<T>(type: string, id: string|number): ParsedObject<T> | undefined {
        const cacheKey = `${type}-${id}`
        const filePath = this.cacheById[cacheKey]
        if (filePath) {
            const cachedObject = this.getCachedObjectByFile<T>(filePath)
            if (cachedObject) {
                return cachedObject
            }
            // here we have the id in cache but not the object itself in the other cache, so we
            // should remove from the id cache
            delete this.cacheById[cacheKey]
        }
    }

    private async getFilesForType(type: string) {
        if (!this.objectTypes[type]) {
            throw new NoSuchObjectTypeError(type)
        }
        if (!this.filenameCache[type]) {
            this.filenameCache[type] = await glob(path.join(this.baseDir, this.objectTypes[type].dirName, '**/*.md'))
        }
        return this.filenameCache[type]
    }
}

export {MarkdownDB}
