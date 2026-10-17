/**
 * A raised ticket keeps its place across retries: a person who joined a row's request must not drop back behind
 * the rows when Apple asks Kima to slow down and the request queues again.
 */
import { rateLimiter, INTERACTIVE_PRIORITY, type QueueTicket } from '../rateLimiter';

it('queues a retry at the place its ticket was raised to while it waited', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const queue = (rateLimiter as any).queues.get('itunes');
    const add = jest.spyOn(queue, 'add');
    const ticket: QueueTicket = { priority: 0, waitingId: null };
    const limited: any = new Error('Request failed with status code 429');
    limited.response = { status: 429, headers: { 'retry-after': '1' } };
    let calls = 0;
    const result = rateLimiter.execute('itunes', async () => {
        calls++;
        if (calls === 1) {
            setTimeout(() => rateLimiter.raise('itunes', ticket, INTERACTIVE_PRIORITY), 0); // raised during the backoff
            throw limited;
        }
        return 'ok';
    }, { ticket });
    expect(await result).toBe('ok');
    expect(add.mock.calls.map((c: any) => c[1].priority)).toEqual([0, INTERACTIVE_PRIORITY]);
    expect(ticket.waitingId).toBeNull();
    add.mockRestore();
}, 15000);

it('never lowers a ticket', () => {
    const ticket: QueueTicket = { priority: INTERACTIVE_PRIORITY, waitingId: null };
    rateLimiter.raise('itunes', ticket, 0);
    expect(ticket.priority).toBe(INTERACTIVE_PRIORITY);
});
