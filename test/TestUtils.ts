import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BigNumber as BN, BigNumberish, Contract } from "ethers";
import { ethers, network } from "hardhat";
import moment from "moment";
import { FirstLossCover, PoolConfig } from "../typechain-types";
import {
    FirstLossCoverConfigStruct,
    LPConfigStructOutput,
} from "../typechain-types/contracts/common/PoolConfig.sol/PoolConfig";
import { FirstLossCoverInfo, PayPeriodDuration } from "./BaseTest";
import { CONSTANTS } from "./constants";

export function toBN(number: string | number, decimals: number): BN {
    return BN.from(number).mul(BN.from(10).pow(BN.from(decimals)));
}

export function toToken(number: string | number, decimals: number = 6): BN {
    return toBN(number, decimals);
}

export function sumBNArray(arr: BN[]): BN {
    return arr.reduce((acc, curValue) => acc.add(curValue), BN.from(0));
}

// Calculates x / y with the result rounded up.
export function ceilDiv(x: BN, y: BN): BN {
    if (y.eq(0)) {
        return x.div(y);
    }
    return x.eq(0) ? BN.from(0) : x.sub(1).div(y).add(1);
}

export function isCloseTo(actualValue: BN, expectedValue: BN, delta: BigNumberish): boolean {
    return actualValue.sub(expectedValue).abs().lte(delta);
}

export async function setNextBlockTimestamp(nextTS: BN | number) {
    await network.provider.request({
        method: "evm_setNextBlockTimestamp",
        params: [Number(nextTS)],
    });
}

export async function mineNextBlockWithTimestamp(nextTS: BN | number) {
    await setNextBlockTimestamp(nextTS);
    await network.provider.send("evm_mine", []);
}

export async function evmSnapshot(): Promise<unknown> {
    return await network.provider.request({
        method: "evm_snapshot",
        params: [],
    });
}

export async function evmRevert(sId: unknown) {
    const res = await network.provider.request({
        method: "evm_revert",
        params: [sId],
    });
    if (!res) {
        console.log(`emvRevert failed: ${sId}`);
    }
    return res;
}

export async function getFutureBlockTime(offsetSeconds: number) {
    const block = await getLatestBlock();
    const currentMoment = moment.utc();
    return Math.max(block.timestamp, currentMoment.unix()) + offsetSeconds;
}

export function getStartDateOfPeriod(periodDuration: number, endDate: number): number {
    return timestampToMoment(endDate).subtract(periodDuration, "months").unix();
}

export function getStartOfDay(timestamp: number): number {
    return timestampToMoment(timestamp, "YYYY-MM-DD").unix();
}

export async function getStartOfNextMonth() {
    const block = await getLatestBlock();
    return moment
        .utc(block.timestamp * 1000)
        .add(1, "month")
        .startOf("month")
        .unix();
}

export async function getLatestBlock() {
    return await ethers.provider.getBlock("latest");
}

export function getMaturityDate(
    periodDuration: PayPeriodDuration,
    numPeriods: number,
    timestamp: number,
) {
    const startDateOfNextPeriod = moment
        .utc(timestamp * 1000)
        .add(1, "month")
        .startOf("month");
    if (numPeriods === 0) {
        return startDateOfNextPeriod.unix();
    }
    let monthCount = numPeriods;
    switch (periodDuration) {
        case PayPeriodDuration.Quarterly:
            monthCount *= 3;
            break;
        case PayPeriodDuration.SemiAnnually:
            monthCount *= 6;
            break;
    }
    const maturityDate = startDateOfNextPeriod.add(monthCount, "months");
    return maturityDate.unix();
}

export function timestampToMoment(timestamp: number, format?: string): moment.Moment {
    if (format) {
        const date = moment.unix(timestamp).utc().format(format);
        return moment.unix(dateToTimestamp(date)).utc();
    }
    return moment.unix(timestamp).utc();
}

export function dateToTimestamp(date: string): number {
    return moment.utc(date).unix();
}

export async function overrideLPConfig(
    poolConfigContract: PoolConfig,
    poolOwner: SignerWithAddress,
    overrides: Partial<LPConfigStructOutput>,
) {
    const lpConfig = await poolConfigContract.getLPConfig();
    const newLPConfig = {
        ...lpConfig,
        ...overrides,
    };
    await poolConfigContract.connect(poolOwner).setLPConfig(newLPConfig);
}

export async function getMinFirstLossCoverRequirement(
    firstLossCoverContract: FirstLossCover,
    poolConfigContract: PoolConfig,
): Promise<BN> {
    const poolConfig = await poolConfigContract.getFirstLossCoverConfig(
        firstLossCoverContract.address,
    );
    return poolConfig.minLiquidity;
}

export async function getMinLiquidityRequirementForPoolOwner(
    poolConfigContract: PoolConfig,
): Promise<BN> {
    const lpConfig = await poolConfigContract.getLPConfig();
    const poolCap = lpConfig.liquidityCap;
    const adminRnR = await poolConfigContract.getAdminRnR();
    return poolCap.mul(adminRnR.liquidityRateInBpsByPoolOwner).div(CONSTANTS.BP_FACTOR);
}

export async function getMinLiquidityRequirementForEA(
    poolConfigContract: PoolConfig,
): Promise<BN> {
    const lpConfig = await poolConfigContract.getLPConfig();
    const poolCap = lpConfig.liquidityCap;
    const adminRnR = await poolConfigContract.getAdminRnR();
    return poolCap.mul(adminRnR.liquidityRateInBpsByEA).div(CONSTANTS.BP_FACTOR);
}

export async function getFirstLossCoverInfo(
    firstLossCoverContract: FirstLossCover,
    poolConfigContract: PoolConfig,
): Promise<FirstLossCoverInfo> {
    const config = await poolConfigContract.getFirstLossCoverConfig(
        firstLossCoverContract.address,
    );
    const totalAssets = await firstLossCoverContract.totalAssets();
    const coveredLoss = await firstLossCoverContract.coveredLoss();
    return {
        config,
        asset: totalAssets,
        coveredLoss,
    };
}

export async function overrideFirstLossCoverConfig(
    firstLossCoverContract: FirstLossCover,
    firstLossCoverIndex: number,
    poolConfigContract: PoolConfig,
    poolOwner: SignerWithAddress,
    overrides: Partial<FirstLossCoverConfigStruct>,
) {
    const config = await poolConfigContract.getFirstLossCoverConfig(
        firstLossCoverContract.address,
    );
    const newConfig = {
        ...config,
        ...overrides,
    };
    await poolConfigContract
        .connect(poolOwner)
        .setFirstLossCover(firstLossCoverIndex, firstLossCoverContract.address, newConfig);
}

export function maxBigNumber(...values: BN[]): BN {
    return values.reduce((acc, currentValue) => {
        return acc.gt(currentValue) ? acc : currentValue;
    }, BN.from(0));
}

export function minBigNumber(...values: BN[]): BN {
    return values.reduce((acc, currentValue) => {
        return acc.lt(currentValue) ? acc : currentValue;
    }, BN.from(ethers.constants.MaxUint256));
}

export async function borrowerLevelCreditHash(
    creditContract: Contract,
    borrower: SignerWithAddress,
) {
    return ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
            ["address", "address"],
            [creditContract.address, await borrower.getAddress()],
        ),
    );
}

export async function receivableLevelCreditHash(
    creditContract: Contract,
    nftContract: Contract,
    tokenId: BN,
) {
    return ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
            ["address", "address", "uint256"],
            [creditContract.address, nftContract.address, tokenId],
        ),
    );
}
