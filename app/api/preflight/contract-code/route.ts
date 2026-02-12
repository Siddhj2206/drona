import { NextResponse } from "next/server";
import { z } from "zod";
import { getContractCodeStatus } from "@/lib/chains/evm/base-rpc";

export const runtime = "nodejs";

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid address");

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const addressParam = searchParams.get("address")?.trim() ?? "";
  const parsedAddress = addressSchema.safeParse(addressParam);

  if (!parsedAddress.success) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  const address = parsedAddress.data.toLowerCase();
  const status = await getContractCodeStatus(address);

  return NextResponse.json({
    chain: "base",
    address,
    ...status,
  });
}
