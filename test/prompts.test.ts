import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudePromptWriteError, readClaudePrompts, writeClaudePrompt } from '../src/prompts.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-claude-prompts-'))
  roots.push(root)
  return join(root, 'prompts')
}

describe('Claude prompt snippet directory', () => {
  it('answers an empty roll before the user has saved anything', async () => {
    await expect(readClaudePrompts(await fixture())).resolves.toEqual([])
  })

  it('names each prompt after its file and summarizes its opening line', async () => {
    const dir = await fixture()
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '写单测.md'), '照现有测试风格补单测。\n\n只覆盖新增分支。\n')

    await expect(readClaudePrompts(dir)).resolves.toEqual([{
      name: '写单测',
      description: '照现有测试风格补单测。',
      body: '照现有测试风格补单测。\n\n只覆盖新增分支。\n',
    }])
  })

  it('skips leading blank lines when summarizing, and collapses the line it finds', async () => {
    const dir = await fixture()
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'review.md'), '\n\n   Review   this    diff\nand say why\n')

    const [prompt] = await readClaudePrompts(dir)
    expect(prompt?.description).toBe('Review this diff')
  })

  it('ignores everything that is not a readable markdown prompt', async () => {
    const dir = await fixture()
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(join(dir, 'notes.txt'), 'not a prompt')
    await writeFile(join(dir, 'empty.md'), '   \n')
    await writeFile(join(dir, '.hidden.md'), 'leading dot is not a usable name')
    await writeFile(join(dir, 'huge.md'), 'x'.repeat(16 * 1024 + 1))
    await writeFile(join(dir, 'keep.md'), 'the only real one')

    await expect(readClaudePrompts(dir)).resolves.toEqual([
      { name: 'keep', description: 'the only real one', body: 'the only real one' },
    ])
  })

  it('sorts the roll by name so the menu order does not follow the file system', async () => {
    const dir = await fixture()
    await mkdir(dir, { recursive: true })
    for (const name of ['charlie', 'alpha', 'bravo']) await writeFile(join(dir, `${name}.md`), name)

    const prompts = await readClaudePrompts(dir)
    expect(prompts.map(prompt => prompt.name)).toEqual(['alpha', 'bravo', 'charlie'])
  })
})

describe('Saving a prompt snippet', () => {
  it('writes the draft under the given name and reads it back', async () => {
    const dir = await fixture()

    await expect(writeClaudePrompt(dir, '写单测', '照现有测试风格补单测。')).resolves.toMatchObject({ name: '写单测' })
    await expect(readClaudePrompts(dir)).resolves.toEqual([{
      name: '写单测',
      description: '照现有测试风格补单测。',
      // The body is stored newline-terminated, and returned verbatim.
      body: '照现有测试风格补单测。\n',
    }])
  })

  it('refuses a name that could address anything outside the prompts directory', async () => {
    const dir = await fixture()

    for (const name of ['../escape', 'nested/deep', '.hidden', '', 'a'.repeat(200), 42, undefined]) {
      await expect(writeClaudePrompt(dir, name, 'body')).rejects.toMatchObject({ code: 'invalid-name' })
    }
    // Nothing was created — not even the directory, since validation precedes it.
    await expect(readClaudePrompts(dir)).resolves.toEqual([])
  })

  it('refuses an empty or oversized body', async () => {
    const dir = await fixture()

    await expect(writeClaudePrompt(dir, 'blank', '   \n ')).rejects.toMatchObject({ code: 'invalid-body' })
    await expect(writeClaudePrompt(dir, 'huge', 'x'.repeat(16 * 1024 + 1))).rejects.toMatchObject({ code: 'invalid-body' })
    await expect(readClaudePrompts(dir)).resolves.toEqual([])
  })

  it('never clobbers a prompt the user already keeps', async () => {
    const dir = await fixture()
    await writeClaudePrompt(dir, 'review', 'the original text')

    const clobber = writeClaudePrompt(dir, 'review', 'the replacement text')
    await expect(clobber).rejects.toBeInstanceOf(ClaudePromptWriteError)
    await expect(clobber).rejects.toMatchObject({ code: 'name-taken' })
    await expect(readFile(join(dir, 'review.md'), 'utf8')).resolves.toBe('the original text\n')
  })
})
