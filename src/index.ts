import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { LRUCache } from 'lru-cache'
import frontMatter from 'front-matter'
import { marked } from 'marked'
import Ajv, {JSONSchemaType, ValidateFunction} from 'ajv'
import {pluralize} from 'inflection'
import {glob} from 'glob'
import {fileNameToSlug} from './utils'
import * as _ from 'lodash-es'

const DEFAULT_MAX_CACHE_SIZE = 64 * 1024 * 1024

export interface MarkdownDBOpts {
    baseDir: string,
    maxCacheSize?: number,
}

export interface AddObjectTypeOpts {
    dirName?: string,
    hasMany?: string,
    hasOne?: string,
    belongsTo?: string,
}

interface ObjectType {
    dirName: string,
    schemaValidator: ValidateFunction,
}

export type ParsedObject<T> = T & {
    id: string,
    _html: string,
    _slug: string,
    _path: string,
}

export class NoSuchObjectTypeError extends Error {
    constructor(name: string) {
        super(`Object of type '${name}' was not registered. Use addObjectType to do so`)
    }
}

export default class MarkdownDB {
    protected baseDir: string
    protected objectTypes: Record<string, ObjectType>
    protected cacheByFile: LRUCache<string, ParsedObject<Record<string, any>>>
    protected cacheById: Record<string, string>
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
        this.ajv = new Ajv({allowUnionTypes: true})

    }

    addObjectType<T>(type: string, schema: JSONSchemaType<T>, opts: AddObjectTypeOpts = {}) {
        schema = _.cloneDeep(schema) // we modify schema below and don't want to mess up whatever the user passed in
        let dirName = opts.dirName ?? pluralize(type)
        if (schema.properties.id) {
            throw new Error(`Object schemas cannot include reserved key 'id'`)
        }
        schema.properties.id = {type: ['string', 'number']}
        schema.required.push('id')
        const compiledSchema = this.ajv.compile(schema)
        this.objectTypes[type] = {dirName, schemaValidator: compiledSchema}
    }

    private async getFilesForType(type: string) {
        if (!this.objectTypes[type]) {
            throw new NoSuchObjectTypeError(type)
        }
        return await glob(path.join(this.baseDir, this.objectTypes[type].dirName, '**/*.md'))
    }

    async getObjectsOfType<T>(type: string): Promise<ParsedObject<T>[]> {
        const objects = []
        for (const mdFile of await this.getFilesForType(type)) {
            objects.push(await this.loadObjectFromFile<T>(type, mdFile))
        }
        return objects
    }

    private getCachedObjectByFile<T>(file: string): ParsedObject<T> | undefined {
        const cachedObject = this.cacheByFile.get(file)
        if (cachedObject) {
            return cachedObject as ParsedObject<T>
        }
    }

    private getCachedObjectById<T>(type: string, id: string): ParsedObject<T> | undefined {
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

    async loadObjectFromFile<T>(type: string, mdFile: string): Promise<ParsedObject<T>> {
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
            this.cacheByFile.set(mdFile, cachedObject)
        }
        return cachedObject
    }

    async getObjectById<T>(type: string, id: string): Promise<ParsedObject<T>> {
        let cachedObject = this.getCachedObjectById<T>(type, id)
        if (!cachedObject) {
            for (const mdFile of await this.getFilesForType(type)) {
                const obj = await this.loadObjectFromFile<T>(type, mdFile)
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

}

export {MarkdownDB}
