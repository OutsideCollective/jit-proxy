/* eslint-disable @typescript-eslint/no-unused-vars */
import { JitProxyClient, PriceType } from '../jitProxyClient';
import { PublicKey } from '@solana/web3.js';
import {
	AuctionSubscriber,
	BN,
	BulkAccountLoader,
	DriftClient,
	getAuctionPrice,
	getUserAccountPublicKey,
	getUserStatsAccountPublicKey,
	hasAuctionPrice,
	isVariant,
	MarketType,
	Order,
	OrderStatus,
	OrderTriggerCondition,
	OrderType,
	PositionDirection,
	PostOnlyParams,
	SlotSubscriber,
	SwiftOrderParamsMessage,
	SwiftOrderSubscriber,
	UserAccount,
	UserStatsMap,
	ZERO,
} from '@drift-labs/sdk';
import { SignedSwiftOrderParams } from '@drift-labs/sdk/lib/node/swift/types';
import { decodeUTF8 } from 'tweetnacl-util';

export type UserFilter = (
	userAccount: UserAccount,
	userKey: string,
	order: Order
) => boolean;

export type JitParams = {
	bid: BN;
	ask: BN;
	minPosition: BN;
	maxPosition;
	priceType: PriceType;
	subAccountId?: number;
	postOnlyParams?: PostOnlyParams;
};

export abstract class BaseJitter {
	auctionSubscriber: AuctionSubscriber;
	swiftOrderSubscriber: SwiftOrderSubscriber;
	slotSubscriber: SlotSubscriber;
	driftClient: DriftClient;
	jitProxyClient: JitProxyClient;
	userStatsMap: UserStatsMap;

	perpParams = new Map<number, JitParams>();
	spotParams = new Map<number, JitParams>();

	seenOrders = new Set<string>();
	onGoingAuctions = new Map<string, Promise<void>>();

	userFilter: UserFilter;

	computeUnits: number;
	computeUnitsPrice: number;

	constructor({
		auctionSubscriber,
		jitProxyClient,
		driftClient,
		userStatsMap,
		swiftOrderSubscriber,
		slotSubscriber,
	}: {
		driftClient: DriftClient;
		auctionSubscriber: AuctionSubscriber;
		jitProxyClient: JitProxyClient;
		userStatsMap: UserStatsMap;
		swiftOrderSubscriber?: SwiftOrderSubscriber;
		slotSubscriber?: SlotSubscriber;
	}) {
		this.auctionSubscriber = auctionSubscriber;
		this.driftClient = driftClient;
		this.jitProxyClient = jitProxyClient;
		this.userStatsMap =
			userStatsMap ||
			new UserStatsMap(
				this.driftClient,
				new BulkAccountLoader(this.driftClient.connection, 'confirmed', 0)
			);
		this.slotSubscriber = slotSubscriber;
		this.swiftOrderSubscriber = swiftOrderSubscriber;

		if (this.swiftOrderSubscriber && !this.slotSubscriber) {
			throw new Error('Slot subscriber is required for swift order subscriber');
		}
	}

	async subscribe(): Promise<void> {
		await this.driftClient.subscribe();

		await this.auctionSubscriber.subscribe();
		this.auctionSubscriber.eventEmitter.on(
			'onAccountUpdate',
			async (taker, takerKey, slot) => {
				const takerKeyString = takerKey.toBase58();

				const takerStatsKey = getUserStatsAccountPublicKey(
					this.driftClient.program.programId,
					taker.authority
				);
				for (const order of taker.orders) {
					if (!isVariant(order.status, 'open')) {
						continue;
					}

					if (!hasAuctionPrice(order, slot)) {
						continue;
					}

					if (this.userFilter) {
						if (this.userFilter(taker, takerKeyString, order)) {
							return;
						}
					}

					const orderSignature = this.getOrderSignatures(
						takerKeyString,
						order.orderId
					);

					if (this.seenOrders.has(orderSignature)) {
						continue;
					}
					this.seenOrders.add(orderSignature);

					if (this.onGoingAuctions.has(orderSignature)) {
						continue;
					}

					if (isVariant(order.marketType, 'perp')) {
						if (!this.perpParams.has(order.marketIndex)) {
							return;
						}

						const perpMarketAccount = this.driftClient.getPerpMarketAccount(
							order.marketIndex
						);
						if (
							order.baseAssetAmount
								.sub(order.baseAssetAmountFilled)
								.lte(perpMarketAccount.amm.minOrderSize)
						) {
							return;
						}

						const promise = this.createTryFill(
							taker,
							takerKey,
							takerStatsKey,
							order,
							orderSignature
						).bind(this)();
						this.onGoingAuctions.set(orderSignature, promise);
					} else {
						if (!this.spotParams.has(order.marketIndex)) {
							return;
						}

						const spotMarketAccount = this.driftClient.getSpotMarketAccount(
							order.marketIndex
						);
						if (
							order.baseAssetAmount
								.sub(order.baseAssetAmountFilled)
								.lte(spotMarketAccount.minOrderSize)
						) {
							return;
						}

						const promise = this.createTryFill(
							taker,
							takerKey,
							takerStatsKey,
							order,
							orderSignature
						).bind(this)();
						this.onGoingAuctions.set(orderSignature, promise);
					}
				}
			}
		);
		await this.slotSubscriber?.subscribe();
		await this.swiftOrderSubscriber?.subscribe(
			async (orderMessageRaw, swiftOrderParamsMessage) => {
				const swiftOrderParamsBufHex = Buffer.from(
					orderMessageRaw['order_message']
				);
				const swiftOrderParamsBuf = Buffer.from(
					orderMessageRaw['order_message'],
					'hex'
				);
				const {
					swiftOrderParams,
					subAccountId: takerSubaccountId,
				}: SwiftOrderParamsMessage =
					this.driftClient.decodeSwiftOrderParamsMessage(swiftOrderParamsBuf);

				const takerAuthority = new PublicKey(
					orderMessageRaw['taker_authority']
				);
				const takerUserPubkey = await getUserAccountPublicKey(
					this.driftClient.program.programId,
					takerAuthority,
					takerSubaccountId
				);
				const takerUserPubkeyString = takerUserPubkey.toBase58();
				const takerUserAccount = (
					await this.swiftOrderSubscriber.userMap.mustGet(
						takerUserPubkey.toString()
					)
				).getUserAccount();

				const swiftOrder: Order = {
					status: OrderStatus.OPEN,
					orderType: swiftOrderParams.orderType,
					orderId: this.convertUuidToNumber(orderMessageRaw['uuid']),
					slot: swiftOrderParamsMessage.slot,
					marketIndex: swiftOrderParams.marketIndex,
					marketType: MarketType.PERP,
					baseAssetAmount: swiftOrderParams.baseAssetAmount,
					auctionDuration: swiftOrderParams.auctionDuration!,
					auctionStartPrice: swiftOrderParams.auctionStartPrice!,
					auctionEndPrice: swiftOrderParams.auctionEndPrice!,
					immediateOrCancel: swiftOrderParams.immediateOrCancel,
					direction: swiftOrderParams.direction,
					postOnly: false,
					oraclePriceOffset: swiftOrderParams.oraclePriceOffset ?? 0,
					maxTs: swiftOrderParams.maxTs ?? ZERO,
					reduceOnly: swiftOrderParams.reduceOnly,
					triggerCondition: swiftOrderParams.triggerCondition,
					// Rest are not necessary and set for type conforming
					price: ZERO,
					existingPositionDirection: PositionDirection.LONG,
					triggerPrice: ZERO,
					baseAssetAmountFilled: ZERO,
					quoteAssetAmountFilled: ZERO,
					quoteAssetAmount: ZERO,
					userOrderId: 0,
					postedSlotTail: 0,
				};
				swiftOrder.price = getAuctionPrice(
					swiftOrder,
					this.slotSubscriber?.getSlot(),
					this.driftClient.getOracleDataForPerpMarket(swiftOrder.marketIndex)
						.price
				);

				if (this.userFilter) {
					if (
						this.userFilter(takerUserAccount, takerUserPubkeyString, swiftOrder)
					) {
						return;
					}
				}

				const orderSignature = this.getOrderSignatures(
					takerUserPubkeyString,
					swiftOrder.orderId
				);

				if (this.seenOrders.has(orderSignature)) {
					return;
				}
				this.seenOrders.add(orderSignature);

				if (this.onGoingAuctions.has(orderSignature)) {
					return;
				}

				if (!this.perpParams.has(swiftOrder.marketIndex)) {
					return;
				}

				const perpMarketAccount = this.driftClient.getPerpMarketAccount(
					swiftOrder.marketIndex
				);
				if (swiftOrder.baseAssetAmount.lt(perpMarketAccount.amm.minOrderSize)) {
					return;
				}

				const promise = this.createTrySwiftFill(
					takerAuthority,
					{
						orderParams: swiftOrderParamsBufHex,
						signature: Buffer.from(
							orderMessageRaw['order_signature'],
							'base64'
						),
					},
					decodeUTF8(orderMessageRaw['uuid']),
					takerUserAccount,
					takerUserPubkey,
					getUserStatsAccountPublicKey(
						this.driftClient.program.programId,
						takerUserAccount.authority
					),
					swiftOrder,
					orderSignature,
					orderMessageRaw['market_index']
				).bind(this)();
				this.onGoingAuctions.set(orderSignature, promise);
			}
		);
	}

	createTryFill(
		taker: UserAccount,
		takerKey: PublicKey,
		takerStatsKey: PublicKey,
		order: Order,
		orderSignature: string
	): () => Promise<void> {
		throw new Error('Not implemented');
	}

	createTrySwiftFill(
		authorityToUse: PublicKey,
		signedSwiftOrderParams: SignedSwiftOrderParams,
		uuid: Uint8Array,
		taker: UserAccount,
		takerKey: PublicKey,
		takerStatsKey: PublicKey,
		order: Order,
		orderSignature: string,
		marketIndex: number
	): () => Promise<void> {
		throw new Error('Not implemented');
	}

	deleteOnGoingAuction(orderSignature: string): void {
		this.onGoingAuctions.delete(orderSignature);
		this.seenOrders.delete(orderSignature);
	}

	getOrderSignatures(takerKey: string, orderId: number): string {
		return `${takerKey}-${orderId}`;
	}

	private convertUuidToNumber(uuid: string): number {
		return uuid
			.split('')
			.reduce(
				(n, c) =>
					n * 64 +
					'_~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.indexOf(
						c
					),
				0
			);
	}

	public updatePerpParams(marketIndex: number, params: JitParams): void {
		this.perpParams.set(marketIndex, params);
	}

	public updateSpotParams(marketIndex: number, params: JitParams): void {
		this.spotParams.set(marketIndex, params);
	}

	public setUserFilter(userFilter: UserFilter | undefined): void {
		this.userFilter = userFilter;
	}

	public setComputeUnits(computeUnits: number): void {
		this.computeUnits = computeUnits;
	}

	public setComputeUnitsPrice(computeUnitsPrice: number): void {
		this.computeUnitsPrice = computeUnitsPrice;
	}
}
