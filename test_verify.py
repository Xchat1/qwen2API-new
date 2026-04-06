import asyncio
from legacy.qwen2api import QwenClient as OldClient
from backend.services.qwen_client import QwenClient as NewClient

async def main():
    old = OldClient(None)
    new = NewClient(None, None)
    token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.invalid"
    res1 = await old.verify_token(token)
    res2 = await new.verify_token(token)
    print("Old:", res1)
    print("New:", res2)

asyncio.run(main())
