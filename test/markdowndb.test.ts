import {expect} from 'expect'
import MarkdownDB, {Relation, RelationType, Relations} from '../src/index.js'
import {F1_PATH, F2_PATH, ARTICLE_NAME, ARTICLE_SCHEMA, Article, AUTHOR_NAME, AUTHOR_SCHEMA, Author} from './fixtures.js'

describe('MarkdownDB', () => {
    it('should be able to load an object from a file', async () => {
        const db = new MarkdownDB({baseDir: F1_PATH})
        db.addObjectType<Article>(ARTICLE_NAME, ARTICLE_SCHEMA)
        const articles = await db.getAllByType<Article>(ARTICLE_NAME)
        expect(articles).toHaveLength(1)
    })

    it('should validate that data files match the schema', async () => {
        const db = new MarkdownDB({baseDir: F2_PATH})
        db.addObjectType<Article>(ARTICLE_NAME, ARTICLE_SCHEMA)
        await expect(async () => {
            await db.findById(ARTICLE_NAME, 2)
        }).rejects.toThrowError(/Could not validate/)
    })

    describe('with author/article fixtures', () => {
        const db = new MarkdownDB({baseDir: F1_PATH})
        const articleRelations: Relations = {
            author: {
                relType: RelationType.HasOne,
                objType: 'author',
                required: true,
            }
        } as const
        const authorRelations: Relations = {
            articles: {
                relType: RelationType.HasMany,
                objType: 'article',
                required: true,
            }
        } as const
        db.addObjectType<Article>(ARTICLE_NAME, ARTICLE_SCHEMA, {relations: articleRelations})
        db.addObjectType<Author>(AUTHOR_NAME, AUTHOR_SCHEMA, {relations: authorRelations})

        it('should load relations', async () => {
            const author = await db.findById<Author>(AUTHOR_NAME, 1)
            expect(author.articles).toHaveLength(1)
            expect(author.articles[0].title).toBe('A Really Great Article')
            const article = await db.findById<Article>(ARTICLE_NAME, 1)
            expect(article.author.name).toBe('Jonathan Lipps')
        })

        it('should allow basic AND type queries', async () => {
            let authors = await db.find<Author>(AUTHOR_NAME, {name: 'Bob'})
            expect(authors).toHaveLength(0)

            authors = await db.find<Author>(AUTHOR_NAME, {name: 'Jonathan Lipps', id: 200})
            expect(authors).toHaveLength(0)

            authors = await db.find<Author>(AUTHOR_NAME, {name: 'Jonathan Lipps'})
            expect(authors).toHaveLength(1)
            expect(authors[0].name).toBe('Jonathan Lipps')
        })
    })

})
