import app from '../hono/hono';
import accountService from '../service/account-service';
import result from '../model/result';
import userContext from '../security/user-context';
import mailboxOrderService from '../service/mailbox-order-service';

app.get('/account/order', async (c) => {
	return c.json(result.ok(await mailboxOrderService.get(c, userContext.getUserId(c))));
});

app.put('/account/order', async (c) => {
	return c.json(result.ok(await mailboxOrderService.save(c, await c.req.json(), userContext.getUserId(c))));
});

app.get('/account/list', async (c) => {
	const list = await accountService.list(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok(list));
});

app.delete('/account/delete', async (c) => {
	await accountService.delete(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok());
});

app.post('/account/add', async (c) => {
	const account = await accountService.add(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok(account));
});

app.put('/account/setName', async (c) => {
	await accountService.setName(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok());
});

app.put('/account/setAllReceive', async (c) => {
	await accountService.setAllReceive(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok());
});

app.put('/account/setAsTop', async (c) => {
	await accountService.setAsTop(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok());
});
