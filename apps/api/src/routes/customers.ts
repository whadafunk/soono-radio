import { FastifyInstance } from 'fastify';
import { eq, and, inArray, sql } from 'drizzle-orm';
import {
  CustomerCreateSchema,
  CustomerPatchSchema,
  ContactCreateSchema,
  ContactPatchSchema,
  CampaignCreateSchema,
  CampaignPatchSchema,
  CampaignMediaCreateSchema,
} from '@soono/shared';
import { db } from '../db/index.js';
import {
  customers,
  contacts,
  customerContacts,
  campaigns,
  campaignMedia,
  media,
} from '../db/schema.js';
import { invalidateInventory, invalidateDemand } from '../services/spotBudget.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function syncExclusions(campaignId: number, newExclusions: number[]) {
  const [existing] = await db.select({ competing_exclusions: campaigns.competing_exclusions })
    .from(campaigns).where(eq(campaigns.id, campaignId));
  if (!existing) return;
  const old: number[] = (existing.competing_exclusions as number[]) ?? [];
  const removed = old.filter((id) => !newExclusions.includes(id));
  const added = newExclusions.filter((id) => !old.includes(id));

  for (const otherId of removed) {
    const [other] = await db.select({ competing_exclusions: campaigns.competing_exclusions })
      .from(campaigns).where(eq(campaigns.id, otherId));
    if (!other) continue;
    const filtered = ((other.competing_exclusions as number[]) ?? []).filter((id) => id !== campaignId);
    await db.update(campaigns)
      .set({ competing_exclusions: filtered, updated_at: sql`(unixepoch())` })
      .where(eq(campaigns.id, otherId));
  }
  for (const otherId of added) {
    const [other] = await db.select({ competing_exclusions: campaigns.competing_exclusions })
      .from(campaigns).where(eq(campaigns.id, otherId));
    if (!other) continue;
    const current = (other.competing_exclusions as number[]) ?? [];
    if (!current.includes(campaignId)) {
      await db.update(campaigns)
        .set({ competing_exclusions: [...current, campaignId], updated_at: sql`(unixepoch())` })
        .where(eq(campaigns.id, otherId));
    }
  }
}

export async function customerRoutes(fastify: FastifyInstance) {
  // ─── Customers ──────────────────────────────────────────────────────────────

  fastify.get<{ Querystring: { active?: string } }>('/customers', async (request, reply) => {
    const rows = await db.select().from(customers);
    const { active } = request.query;
    if (active === 'true') return reply.send(rows.filter((c) => c.active));
    if (active === 'false') return reply.send(rows.filter((c) => !c.active));
    return reply.send(rows);
  });

  fastify.post<{ Body: unknown }>('/customers', async (request, reply) => {
    const parsed = CustomerCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const [customer] = await db.insert(customers).values({
      name: parsed.data.name,
      email: parsed.data.email ?? null,
      phone: parsed.data.phone ?? null,
      notes: parsed.data.notes ?? null,
      account_manager_id: parsed.data.account_manager_id ?? null,
    }).returning();
    return reply.status(201).send(customer);
  });

  fastify.get<{ Params: { id: string } }>('/customers/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const [customer] = await db.select().from(customers).where(eq(customers.id, id));
    if (!customer) return reply.status(404).send({ error: 'Customer not found' });
    return reply.send(customer);
  });

  fastify.patch<{ Params: { id: string }; Body: unknown }>('/customers/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const parsed = CustomerPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const [updated] = await db.update(customers)
      .set({ ...parsed.data, updated_at: sql`(unixepoch())` })
      .where(eq(customers.id, id))
      .returning();
    if (!updated) return reply.status(404).send({ error: 'Customer not found' });
    return reply.send(updated);
  });

  fastify.delete<{ Params: { id: string } }>('/customers/:id', async (request, reply) => {
    const id = Number(request.params.id);
    await db.delete(customers).where(eq(customers.id, id));
    return reply.status(204).send();
  });

  // ─── Contacts ───────────────────────────────────────────────────────────────

  // All contacts (for the global Contacts tab)
  fastify.get('/contacts', async (_req, reply) => {
    const rows = await db.select().from(contacts);
    return reply.send(rows);
  });

  // Contacts with customer associations (for the Contacts tab with customer names)
  fastify.get('/contacts/with-customers', async (_req, reply) => {
    const allContacts = await db.select().from(contacts);
    const allJunctions = await db.select().from(customerContacts);
    const customerIds = [...new Set(allJunctions.map((j) => j.customer_id))];
    const allCustomers = customerIds.length > 0
      ? await db.select({ id: customers.id, name: customers.name })
          .from(customers).where(inArray(customers.id, customerIds))
      : [];
    const customerMap = new Map(allCustomers.map((c) => [c.id, c.name]));

    return reply.send(allContacts.map((contact) => {
      const junctions = allJunctions.filter((j) => j.contact_id === contact.id);
      const customer_ids = junctions.map((j) => j.customer_id);
      const customer_names = customer_ids.map((id) => customerMap.get(id) ?? 'Unknown');
      return { ...contact, customer_ids, customer_names };
    }));
  });

  // Contacts for a specific customer (with is_primary flag)
  fastify.get<{ Params: { id: string } }>('/customers/:id/contacts', async (request, reply) => {
    const customerId = Number(request.params.id);
    const junctions = await db.select().from(customerContacts)
      .where(eq(customerContacts.customer_id, customerId));
    if (junctions.length === 0) return reply.send([]);
    const contactIds = junctions.map((j) => j.contact_id);
    const rows = await db.select().from(contacts).where(inArray(contacts.id, contactIds));
    const primaryMap = new Map(junctions.map((j) => [j.contact_id, j.is_primary]));
    return reply.send(rows.map((c) => ({ ...c, is_primary: primaryMap.get(c.id) ?? false })));
  });

  fastify.post<{ Body: unknown }>('/contacts', async (request, reply) => {
    const parsed = ContactCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const [contact] = await db.insert(contacts).values({
      customer_id: parsed.data.customer_id ?? null,
      name: parsed.data.name,
      email: parsed.data.email ?? null,
      phone: parsed.data.phone ?? null,
      role: parsed.data.role ?? null,
      notes: parsed.data.notes ?? null,
    }).returning();
    // If customer_id provided, auto-create junction entry
    if (parsed.data.customer_id) {
      const existing = await db.select().from(customerContacts)
        .where(eq(customerContacts.customer_id, parsed.data.customer_id));
      const hasPrimary = existing.some((j) => j.is_primary);
      await db.insert(customerContacts).values({
        customer_id: parsed.data.customer_id,
        contact_id: contact.id,
        is_primary: !hasPrimary,
      });
    }
    return reply.status(201).send(contact);
  });

  fastify.patch<{ Params: { id: string }; Body: unknown }>('/contacts/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const parsed = ContactPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const [updated] = await db.update(contacts)
      .set({ ...parsed.data, updated_at: sql`(unixepoch())` })
      .where(eq(contacts.id, id))
      .returning();
    if (!updated) return reply.status(404).send({ error: 'Contact not found' });
    return reply.send(updated);
  });

  fastify.delete<{ Params: { id: string } }>('/contacts/:id', async (request, reply) => {
    const id = Number(request.params.id);
    await db.delete(contacts).where(eq(contacts.id, id));
    return reply.status(204).send();
  });

  // Associate / dissociate an existing contact with a customer
  fastify.post<{ Params: { id: string; contactId: string }; Body: { is_primary?: boolean } }>(
    '/customers/:id/contacts/:contactId',
    async (request, reply) => {
      const customerId = Number(request.params.id);
      const contactId = Number(request.params.contactId);
      const isPrimary = request.body?.is_primary ?? false;
      if (isPrimary) {
        await db.update(customerContacts)
          .set({ is_primary: false })
          .where(eq(customerContacts.customer_id, customerId));
      }
      await db.insert(customerContacts)
        .values({ customer_id: customerId, contact_id: contactId, is_primary: isPrimary })
        .onConflictDoUpdate({
          target: [customerContacts.customer_id, customerContacts.contact_id],
          set: { is_primary: isPrimary },
        });
      return reply.status(204).send();
    },
  );

  fastify.delete<{ Params: { id: string; contactId: string } }>(
    '/customers/:id/contacts/:contactId',
    async (request, reply) => {
      const customerId = Number(request.params.id);
      const contactId = Number(request.params.contactId);
      await db.delete(customerContacts).where(
        and(
          eq(customerContacts.customer_id, customerId),
          eq(customerContacts.contact_id, contactId),
        ),
      );
      return reply.status(204).send();
    },
  );

  fastify.patch<{ Params: { id: string; contactId: string }; Body: { is_primary: boolean } }>(
    '/customers/:id/contacts/:contactId/primary',
    async (request, reply) => {
      const customerId = Number(request.params.id);
      const contactId = Number(request.params.contactId);
      const { is_primary } = request.body;
      if (is_primary) {
        await db.update(customerContacts)
          .set({ is_primary: false })
          .where(eq(customerContacts.customer_id, customerId));
      }
      await db.update(customerContacts)
        .set({ is_primary })
        .where(
          and(
            eq(customerContacts.customer_id, customerId),
            eq(customerContacts.contact_id, contactId),
          ),
        );
      return reply.status(204).send();
    },
  );

  // ─── Campaigns ──────────────────────────────────────────────────────────────

  fastify.get<{ Querystring: { customer_id?: string } }>('/campaigns', async (request, reply) => {
    const { customer_id } = request.query;
    const rows = customer_id
      ? await db.select().from(campaigns).where(eq(campaigns.customer_id, Number(customer_id)))
      : await db.select().from(campaigns);
    // Join customer name
    const customerIds = [...new Set(rows.map((r) => r.customer_id))];
    const customerRows = customerIds.length > 0
      ? await db.select({ id: customers.id, name: customers.name })
          .from(customers).where(inArray(customers.id, customerIds))
      : [];
    const nameMap = new Map(customerRows.map((c) => [c.id, c.name]));
    return reply.send(rows.map((c) => ({ ...c, customer_name: nameMap.get(c.customer_id) ?? 'Unknown' })));
  });

  fastify.post<{ Body: unknown }>('/campaigns', async (request, reply) => {
    const parsed = CampaignCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const [campaign] = await db.insert(campaigns).values({
      customer_id: parsed.data.customer_id,
      name: parsed.data.name,
      starts_on: parsed.data.starts_on,
      ends_on: parsed.data.ends_on,
      total_plays: parsed.data.total_plays,
      duration_bracket: parsed.data.duration_bracket,
      max_plays_per_day: parsed.data.max_plays_per_day ?? null,
      min_gap_minutes: parsed.data.min_gap_minutes ?? null,
      pacing_mode: parsed.data.pacing_mode ?? 'even',
      catch_up_factor: parsed.data.catch_up_factor ?? null,
      allowed_interval_ids: parsed.data.allowed_interval_ids ?? null,
      sweeps_per_month: parsed.data.sweeps_per_month ?? null,
      max_sweeps_per_day: parsed.data.max_sweeps_per_day ?? null,
      advertiser_separation_spots: parsed.data.advertiser_separation_spots ?? 1,
      competing_exclusions: parsed.data.competing_exclusions ?? [],
      interval_id: parsed.data.interval_id ?? null,
      interval_plays_per_day: parsed.data.interval_plays_per_day ?? null,
      show_id: parsed.data.show_id ?? null,
      plays_per_show: parsed.data.plays_per_show ?? null,
      first_in_slot: parsed.data.first_in_slot ?? false,
      first_in_slot_mode: parsed.data.first_in_slot_mode ?? null,
      notes: parsed.data.notes ?? null,
    }).returning();
    if (campaign.competing_exclusions && (campaign.competing_exclusions as number[]).length > 0) {
      await syncExclusions(campaign.id, campaign.competing_exclusions as number[]);
    }
    invalidateInventory();
    invalidateDemand();
    return reply.status(201).send(campaign);
  });

  fastify.get<{ Params: { id: string } }>('/campaigns/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
    if (!campaign) return reply.status(404).send({ error: 'Campaign not found' });
    return reply.send(campaign);
  });

  fastify.patch<{ Params: { id: string }; Body: unknown }>('/campaigns/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const parsed = CampaignPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    if (parsed.data.competing_exclusions !== undefined) {
      await syncExclusions(id, parsed.data.competing_exclusions);
    }
    const [updated] = await db.update(campaigns)
      .set({ ...parsed.data, updated_at: sql`(unixepoch())` })
      .where(eq(campaigns.id, id))
      .returning();
    if (!updated) return reply.status(404).send({ error: 'Campaign not found' });
    invalidateInventory();
    invalidateDemand();
    return reply.send(updated);
  });

  fastify.delete<{ Params: { id: string } }>('/campaigns/:id', async (request, reply) => {
    const id = Number(request.params.id);
    // D96 hygiene: clear this id out of partners' exclusion lists BEFORE the
    // row goes away, so no dangling references survive the delete.
    await syncExclusions(id, []);
    await db.delete(campaigns).where(eq(campaigns.id, id));
    invalidateInventory();
    invalidateDemand();
    return reply.status(204).send();
  });

  // Pacing stub — real calculation requires play tracking per campaign
  fastify.get<{ Params: { id: string } }>('/campaigns/:id/pacing', async (request, reply) => {
    const id = Number(request.params.id);
    const [campaign] = await db.select({ total_plays: campaigns.total_plays })
      .from(campaigns).where(eq(campaigns.id, id));
    if (!campaign) return reply.status(404).send({ error: 'Campaign not found' });
    return reply.send({
      plays_this_month: 0,
      target: campaign.total_plays,
      pct: 0,
      on_track: false,
    });
  });

  // ─── Campaign Media ──────────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>('/campaigns/:id/media', async (request, reply) => {
    const campaignId = Number(request.params.id);
    const rows = await db
      .select({
        id: campaignMedia.id,
        campaign_id: campaignMedia.campaign_id,
        media_id: campaignMedia.media_id,
        play_as_spot: campaignMedia.play_as_spot,
        play_as_sweep: campaignMedia.play_as_sweep,
        weight: campaignMedia.weight,
        created_at: campaignMedia.created_at,
        title: media.title,
        artist: media.artist,
        duration_seconds: media.duration_seconds,
        original_filename: media.original_filename,
      })
      .from(campaignMedia)
      .leftJoin(media, eq(campaignMedia.media_id, media.id))
      .where(eq(campaignMedia.campaign_id, campaignId));
    return reply.send(rows);
  });

  fastify.post<{ Params: { id: string }; Body: unknown }>('/campaigns/:id/media', async (request, reply) => {
    const campaignId = Number(request.params.id);
    const parsed = CampaignMediaCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const [entry] = await db.insert(campaignMedia).values({
      campaign_id: campaignId,
      media_id: parsed.data.media_id,
      play_as_spot: parsed.data.play_as_spot ?? true,
      play_as_sweep: parsed.data.play_as_sweep ?? false,
      weight: parsed.data.weight ?? 1,
    }).returning();
    // Re-fetch with media join
    const [withMedia] = await db
      .select({
        id: campaignMedia.id,
        campaign_id: campaignMedia.campaign_id,
        media_id: campaignMedia.media_id,
        play_as_spot: campaignMedia.play_as_spot,
        play_as_sweep: campaignMedia.play_as_sweep,
        weight: campaignMedia.weight,
        created_at: campaignMedia.created_at,
        title: media.title,
        artist: media.artist,
        duration_seconds: media.duration_seconds,
        original_filename: media.original_filename,
      })
      .from(campaignMedia)
      .leftJoin(media, eq(campaignMedia.media_id, media.id))
      .where(eq(campaignMedia.id, entry.id));
    return reply.status(201).send(withMedia);
  });

  fastify.patch<{ Params: { id: string }; Body: { play_as_spot?: boolean; play_as_sweep?: boolean; weight?: number } }>(
    '/campaign-media/:id',
    async (request, reply) => {
      const id = Number(request.params.id);
      const patch: { play_as_spot?: boolean; play_as_sweep?: boolean; weight?: number } = {};
      if (request.body.play_as_spot !== undefined) patch.play_as_spot = request.body.play_as_spot;
      if (request.body.play_as_sweep !== undefined) patch.play_as_sweep = request.body.play_as_sweep;
      if (request.body.weight !== undefined && Number.isInteger(request.body.weight) && request.body.weight >= 0 && request.body.weight <= 10) {
        patch.weight = request.body.weight;
      }
      const [updated] = await db.update(campaignMedia)
        .set(patch)
        .where(eq(campaignMedia.id, id))
        .returning();
      if (!updated) return reply.status(404).send({ error: 'Campaign media not found' });
      return reply.send(updated);
    },
  );

  fastify.delete<{ Params: { id: string } }>('/campaign-media/:id', async (request, reply) => {
    const id = Number(request.params.id);
    await db.delete(campaignMedia).where(eq(campaignMedia.id, id));
    return reply.status(204).send();
  });
}
