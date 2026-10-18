/**
 * Comprobación de la BD (pnpm db:check): conexión, migraciones aplicadas y búsqueda en español.
 * La prueba de búsqueda se hace dentro de una transacción que se deshace: no deja datos.
 */
import { createDb, searchGenerationIds } from '../src/index.js';

class Rollback extends Error {}

async function main() {
  const db = createDb();
  try {
    const [{ version }] = await db.$queryRaw<{ version: string }[]>`SELECT version()`;
    console.log(`✔ Conexión: ${version.split(',')[0]}`);

    const migrations = await db.$queryRaw<{ migration_name: string; finished_at: Date | null }[]>`
      SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY migration_name`;
    for (const m of migrations) console.log(`${m.finished_at ? '✔' : '✖'} Migración ${m.migration_name}`);
    if (!migrations.length || migrations.some((m) => !m.finished_at)) throw new Error('Faltan migraciones: ejecuta pnpm db:migrate');

    const users = await db.user.count();
    const admins = await db.user.count({ where: { role: 'admin', active: true } });
    console.log(`${admins ? '✔' : '·'} Usuarios: ${users} (${admins} admin activo${admins === 1 ? '' : 's'})${admins ? '' : ' → crea el admin con pnpm db:admin'}`);

    let found: string[] = [];
    await db
      .$transaction(async (tx) => {
        const u = await tx.user.create({ data: { email: `check-${Date.now()}@wilox.local`, passwordHash: 'x' } });
        await tx.generation.create({
          data: {
            id: 'check-busqueda',
            ownerId: u.id,
            mode: 'mock',
            themeKey: 'pastel',
            themeCopy: {},
            voiceId: 'x',
            text: 'Las infecciones asociadas a la atención de salud afectan a los pacientes hospitalizados.',
            dir: 'runs/check-busqueda',
          },
        });
        found = await searchGenerationIds(tx, u.id, 'infeccion hospitalizado');
        throw new Rollback();
      })
      .catch((e) => {
        if (!(e instanceof Rollback)) throw e;
      });
    if (found[0] !== 'check-busqueda') throw new Error('La búsqueda full-text no encontró el texto de prueba.');
    console.log('✔ Búsqueda en español sin tildes ("infeccion hospitalizado" → "infecciones … hospitalizados")');
    console.log('Todo en orden.');
  } finally {
    await db.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(`✖ ${e.message}`);
  process.exit(1);
});
