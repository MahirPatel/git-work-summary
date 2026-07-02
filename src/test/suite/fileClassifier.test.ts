import * as assert from 'assert';
import {
  buildCategoryBulletText,
  classifyFile,
  detectLanguage,
  humanizeCommitMessage
} from '../../utils/fileClassifier';

describe('fileClassifier.classifyFile', () => {
  it('classifies src/auth/LoginService.ts as Authentication (spec example)', () => {
    const result = classifyFile('src/auth/LoginService.ts');
    assert.strictEqual(result.category, 'Authentication');
  });

  it('classifies controllers/InvoiceController.php as Invoice Processing (spec example)', () => {
    const result = classifyFile('controllers/InvoiceController.php');
    assert.strictEqual(result.category, 'Invoice Processing');
  });

  it('classifies routes/api.php as API Routes (spec example)', () => {
    const result = classifyFile('routes/api.php');
    assert.strictEqual(result.category, 'API Routes');
    assert.strictEqual(result.fixedPhrase, 'Updated application routing');
  });

  it('classifies a generic controller with no domain keyword as Business Logic', () => {
    const result = classifyFile('src/controllers/UserController.ts');
    assert.strictEqual(result.category, 'Business Logic');
    assert.strictEqual(result.fixedPhrase, 'Updated business logic');
  });

  it('classifies SQL files as Database', () => {
    const result = classifyFile('db/migrations/001_init.sql');
    assert.strictEqual(result.category, 'Database');
    assert.strictEqual(result.fixedPhrase, 'Improved database queries');
  });

  it('classifies README changes as Documentation', () => {
    const result = classifyFile('README.md');
    assert.strictEqual(result.fixedPhrase, 'Updated documentation');
  });

  it('classifies package.json as Dependencies', () => {
    const result = classifyFile('package.json');
    assert.strictEqual(result.fixedPhrase, 'Updated project dependencies');
  });

  it('prioritizes Testing over a domain folder (auth test file is still Testing)', () => {
    const result = classifyFile('src/auth/LoginService.test.ts');
    assert.strictEqual(result.category, 'Testing');
    assert.strictEqual(result.fixedPhrase, 'Added test coverage');
  });

  it('prioritizes Documentation over a domain folder', () => {
    const result = classifyFile('docs/payment-integration.md');
    assert.strictEqual(result.category, 'Documentation');
  });

  it('falls back to a folder-derived category for unrecognized paths', () => {
    const result = classifyFile('src/orders/OrderSummary.ts');
    assert.strictEqual(result.category, 'Orders');
    assert.strictEqual(result.fixedPhrase, undefined);
  });

  it('falls back to General for a root file with no useful folder', () => {
    const result = classifyFile('notes.txt');
    assert.strictEqual(result.category, 'General');
  });
});

describe('fileClassifier.detectLanguage', () => {
  it('detects TypeScript', () => {
    assert.strictEqual(detectLanguage('src/index.ts'), 'TypeScript');
  });

  it('detects PHP', () => {
    assert.strictEqual(detectLanguage('controllers/InvoiceController.php'), 'PHP');
  });

  it('falls back to Other for unknown extensions', () => {
    assert.strictEqual(detectLanguage('data.xyz123'), 'Other');
  });
});

describe('fileClassifier.buildCategoryBulletText', () => {
  it('always returns the fixed phrase when one is configured, regardless of count', () => {
    const text = buildCategoryBulletText('Testing', 'Added test coverage', new Set(['modified']), 5);
    assert.strictEqual(text, 'Added test coverage');
  });

  it('uses "Improved X module" for multiple files in an open category', () => {
    const text = buildCategoryBulletText('Authentication', undefined, new Set(['modified', 'created']), 3);
    assert.strictEqual(text, 'Improved authentication module');
  });

  it('uses "Added new X feature" for a single newly created file', () => {
    const text = buildCategoryBulletText('Payment Processing', undefined, new Set(['created']), 1);
    assert.strictEqual(text, 'Added new payment processing feature');
  });

  it('uses "Updated X" for a single modified file', () => {
    const text = buildCategoryBulletText('Authentication', undefined, new Set(['modified']), 1);
    assert.strictEqual(text, 'Updated authentication');
  });
});

describe('fileClassifier.humanizeCommitMessage', () => {
  it('converts a bare imperative verb to past tense (spec example)', () => {
    assert.strictEqual(
      humanizeCommitMessage('fix invoice calculation rounding'),
      'Fixed invoice calculation rounding'
    );
  });

  it('strips a conventional-commit type prefix and converts the remaining verb', () => {
    assert.strictEqual(humanizeCommitMessage('feat(auth): add login throttling'), 'Added login throttling');
  });

  it('falls back to the type-word verb when the remainder has no recognizable verb', () => {
    assert.strictEqual(humanizeCommitMessage('fix: invoice rounding bug'), 'Fixed invoice rounding bug');
  });

  it('leaves an already well-formed subject alone (capitalized)', () => {
    assert.strictEqual(
      humanizeCommitMessage('Refactored payment module for clarity'),
      'Refactored payment module for clarity'
    );
  });

  it('never returns an empty string', () => {
    assert.strictEqual(humanizeCommitMessage('   '), 'Made changes');
  });
});
