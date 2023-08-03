import {expect} from 'expect'
import MarkdownDB, {RelationType} from '../src'
import {F1_PATH, F2_PATH, ARTICLE_NAME, ARTICLE_SCHEMA, Article, AUTHOR_NAME, AUTHOR_SCHEMA, Author} from './fixtures'

describe('MarkdownDB', () => {
    it('should be able to load an object from a file', async () => {
        const db = new MarkdownDB({baseDir: F1_PATH})
        db.addObjectType<Article>(ARTICLE_NAME, ARTICLE_SCHEMA)
        const articles = await db.getObjectsOfType<Article>(ARTICLE_NAME)
        expect(articles).toHaveLength(1)
    })

    it('should validate that data files match the schema', async () => {
        const db = new MarkdownDB({baseDir: F2_PATH})
        db.addObjectType<Article>(ARTICLE_NAME, ARTICLE_SCHEMA)
        await expect(async () => {
            await db.getObjectById(ARTICLE_NAME, 2)
        }).rejects.toThrowError(/Could not validate/)
    })

    it('should load hasMany relationships', async () => {
        const db = new MarkdownDB({baseDir: F1_PATH})
        db.addObjectType<Article>(ARTICLE_NAME, ARTICLE_SCHEMA)
        db.addObjectType<Author>(AUTHOR_NAME, AUTHOR_SCHEMA, {
            relations: [{
                type: RelationType.HasMany,
                link: 'article',
                required: true,
            }]
        })
        const author = await db.getObjectById<Author>(AUTHOR_NAME, 1)
        expect(author.articles).toHaveLength(1)
        expect(author.articles[0].title).toBe('A Really Great Article')
    })
})
