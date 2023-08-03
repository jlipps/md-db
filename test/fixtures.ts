import {JSONSchemaType} from 'ajv'
import {resolve} from 'node:path'
import * as url from 'node:url'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

const FIXT_PATH = resolve(__dirname, 'fixtures')

export const F1_PATH = resolve(FIXT_PATH, '1')
export const F2_PATH = resolve(FIXT_PATH, '2')

export interface Article {
  author: string,
  title: string,
  date?: number,
}
export const ARTICLE_NAME = 'article'
export const ARTICLE_SCHEMA: JSONSchemaType<Article> = {
  type: 'object',
  properties: {
    author: {type: 'string'},
    title: {type: 'string'},
    date: {type: 'integer', nullable: true},
  },
  required: ['author', 'title'],
}

export interface Author {
    name: string,
}
export const AUTHOR_NAME = 'author'
export const AUTHOR_SCHEMA: JSONSchemaType<Author> = {
    type: 'object',
    properties: {
        name: {type: 'string'},
    },
    required: ['name'],
}
