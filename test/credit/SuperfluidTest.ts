import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import "dotenv/config";
import { BigNumber as BN, providers as ethersProviders } from "ethers";
import { ethers, network } from "hardhat";

import {
    Calendar,
    CreditDueManager,
    EpochManager,
    EvaluationAgentNFT,
    FirstLossCover,
    HumaConfig,
    IConstantFlowAgreementV1,
    IERC20,
    ISuperToken,
    ISuperfluid,
    Pool,
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    Receivable,
    ReceivableFactoringCredit,
    ReceivableLevelCreditManager,
    RiskAdjustedTranchesPolicy,
    SuperfluidProcessor,
    SuperfluidSuperAppRegister,
    TradableStream,
    TrancheVault,
} from "../../typechain-types";
import { CONSTANTS, deployPoolContracts, deployProtocolContracts } from "../BaseTest";
import {
    getFutureBlockTime,
    setNextBlockTimestamp,
    timestampToMoment,
    toToken,
} from "../TestUtils";

type JsonRpcSigner = ethersProviders.JsonRpcSigner;

const GOERLI_CHAIN_ID = 5;
const HARDHAT_CHAIN_ID = 31337;

const POLYGON_USDC_MAP_SLOT = "0x0";
const MUMBAI_USDC_MAP_SLOT = "0x0";

let polygonUrl = process.env["POLYGON_URL"];
let mumbaiUrl = process.env["MUMBAI_URL"];

const POLYGON_USDC_ADDRESS = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const POLYGON_SF_USDCX_ADDRESS = "0xCAa7349CEA390F89641fe306D93591f87595dc1F";
const POLYGON_SF_HOST_ADDRESS = "0x3E14dC1b13c488a8d5D310918780c983bD5982E7";
const POLYGON_SF_CFA_ADDRESS = "0x6EeE6060f715257b970700bc2656De21dEdF074C";
const POLYGON_SF_SUPER_APP_REGISTER_ADDRESS = "0xb9714068220AABAf34E490B04D5D26Cfb4400063";
const POLYGON_SF_SUPER_APP_REGISTER_OWNER = "0x9ea47a502beffb25c8d559e614203562bb7d886d";
const POLYGON_USDC_DECIMALS = 6;

const MUMBAI_USDC_ADDRESS = "0xbe49ac1EadAc65dccf204D4Df81d650B50122aB2";
const MUMBAI_SF_USDCX_ADDRESS = "0x42bb40bF79730451B11f6De1CbA222F17b87Afd7";
const MUMBAI_SF_HOST_ADDRESS = "0xEB796bdb90fFA0f28255275e16936D25d3418603";
const MUMBAI_SF_CFA_ADDRESS = "0x49e565Ed1bdc17F3d220f72DF0857C26FA83F873";
const MUMBAI_SF_SUPER_APP_REGISTER_ADDRESS = "0x42c87A5521a2234c511089fF55d5FE55589beB47";
const MUMBAI_SF_SUPER_APP_REGISTER_OWNER = "0x60891b087e81ee2a61b7606f68019ec112c539b9";
const MUMBAI_USDC_DECIMALS = 18;

let chainUrl = polygonUrl;
let usdcMapSlot = POLYGON_USDC_MAP_SLOT;
let usdcDecimals = POLYGON_USDC_DECIMALS;

let usdcAddress = POLYGON_USDC_ADDRESS;
let sfUsdcxAddress = POLYGON_SF_USDCX_ADDRESS;
let sfHostAddress = POLYGON_SF_HOST_ADDRESS;
let sfCFAAddress = POLYGON_SF_CFA_ADDRESS;
let sfRegisterAddress = POLYGON_SF_SUPER_APP_REGISTER_ADDRESS;
let sfRegisterOwnerAddress = POLYGON_SF_SUPER_APP_REGISTER_OWNER;

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    pdsServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress;
let lender: SignerWithAddress,
    borrower: SignerWithAddress,
    payer: SignerWithAddress,
    sfRegisterOwner: JsonRpcSigner;

let eaNFTContract: EvaluationAgentNFT, humaConfigContract: HumaConfig;
let poolConfigContract: PoolConfig,
    poolFeeManagerContract: PoolFeeManager,
    poolSafeContract: PoolSafe,
    calendarContract: Calendar,
    borrowerFirstLossCoverContract: FirstLossCover,
    affiliateFirstLossCoverContract: FirstLossCover,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: ReceivableFactoringCredit,
    creditDueManagerContract: CreditDueManager,
    creditManagerContract: ReceivableLevelCreditManager,
    internalReceivableContract: Receivable,
    sfProcessorContract: SuperfluidProcessor,
    sfNftContract: TradableStream,
    sfRegisterContract: SuperfluidSuperAppRegister;

let usdc: IERC20, sf: ISuperfluid, usdcx: ISuperToken, cfa: IConstantFlowAgreementV1;

function toDefaultToken(amount: number) {
    return toToken(amount, 18);
}

function toUSDC(amount: number) {
    return toToken(amount, usdcDecimals);
}

function convertDefaultToUSDC(amount: BN) {
    if (usdcDecimals != 18) {
        return amount
            .mul(BN.from(10).pow(BN.from(usdcDecimals)))
            .div(BN.from(10).pow(BN.from(18)));
    } else {
        return amount;
    }
}

async function mint(address: string, amount: BN) {
    await mintToken(usdc, usdcMapSlot, address, amount);
}

async function mintToken(token: IERC20, mapSlot: string, address: string, amount: BN) {
    const beforeAmount = await token.balanceOf(address);
    const newAmount = amount.add(beforeAmount);
    await setToken(token.address, mapSlot, address, newAmount);
}

async function setToken(tokenAddress: string, mapSlot: string, address: string, amount: BN) {
    const mintAmount = ethers.utils.hexZeroPad(amount.toHexString(), 32);
    const slot = ethers.utils.hexStripZeros(
        ethers.utils.keccak256(
            ethers.utils.defaultAbiCoder.encode(["address", "uint256"], [address, mapSlot]),
        ),
    );
    await network.provider.send("hardhat_setStorageAt", [tokenAddress, slot, mintAmount]);
}

async function createFlow(
    xToken: IERC20,
    payer: SignerWithAddress,
    payee: SignerWithAddress,
    flowrate: BN,
) {
    const calldata = cfa.interface.encodeFunctionData("createFlow", [
        xToken.address,
        payee.address,
        flowrate,
        "0x",
    ]);

    await sf.connect(payer).callAgreement(cfa.address, calldata, "0x");
}

async function authorizeFlow(xToken: IERC20, sender: SignerWithAddress, operatorAddr: string) {
    const calldata = cfa.interface.encodeFunctionData("authorizeFlowOperatorWithFullControl", [
        xToken.address,
        operatorAddr,
        "0x",
    ]);
    await sf.connect(sender).callAgreement(cfa.address, calldata, "0x");
}

async function impersonate(account: string): Promise<JsonRpcSigner> {
    await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [account],
    });
    const amount = BN.from(10).mul(ethers.constants.WeiPerEther);
    await network.provider.send("hardhat_setBalance", [account, amount.toHexString()]);
    return await ethers.provider.getSigner(account);
}

describe.skip("Superfluid Tests", function () {
    before(async function () {
        await network.provider.request({
            method: "hardhat_reset",
            params: [
                {
                    forking: {
                        jsonRpcUrl: chainUrl,
                        // blockNumber: 33667900,
                    },
                },
            ],
        });

        [
            defaultDeployer,
            protocolOwner,
            treasury,
            eaServiceAccount,
            pdsServiceAccount,
            poolOwner,
            poolOwnerTreasury,
            evaluationAgent,
            poolOperator,
            lender,
            borrower,
            payer,
        ] = await ethers.getSigners();
    });

    const yieldInBps = 1200;
    const lateFeeBps = 2400;
    const lateFeeFlat = 0;
    const principalRate = 0;
    const membershipFee = 0;
    const lateGracePeriodInDays = 5;

    async function prepareForSFContracts() {
        usdc = await ethers.getContractAt("IERC20", usdcAddress);
        sf = await ethers.getContractAt("ISuperfluid", sfHostAddress);
        usdcx = await ethers.getContractAt("ISuperToken", sfUsdcxAddress);
        cfa = await ethers.getContractAt("IConstantFlowAgreementV1", sfCFAAddress);

        await mint(lender.address, toUSDC(1_000_000_000));
        await mint(poolOwnerTreasury.address, toUSDC(1_000_000_000));
        await mint(evaluationAgent.address, toUSDC(1_000_000_000));
        await mint(payer.address, toUSDC(1_000_000_000));

        sfRegisterOwner = await impersonate(sfRegisterOwnerAddress);

        await usdc.connect(payer).approve(usdcx.address, toUSDC(1_000_000));
        sfRegisterContract = await ethers.getContractAt(
            "SuperfluidSuperAppRegister",
            sfRegisterAddress,
        );
        const SFNftContractFactory = await ethers.getContractFactory("TradableStream");
        sfNftContract = await SFNftContractFactory.deploy(sfHostAddress);
        await sfNftContract.deployed();
    }

    async function prepare() {
        console.log("prepareForSFContracts...");
        await prepareForSFContracts();
        console.log("prepareForSFContracts is done.");

        [eaNFTContract, humaConfigContract] = await deployProtocolContracts(
            protocolOwner,
            treasury,
            eaServiceAccount,
            pdsServiceAccount,
            poolOwner,
        );
        await humaConfigContract.connect(protocolOwner).setLiquidityAsset(usdc.address, true);

        [
            poolConfigContract,
            poolFeeManagerContract,
            poolSafeContract,
            calendarContract,
            borrowerFirstLossCoverContract,
            affiliateFirstLossCoverContract,
            tranchesPolicyContract,
            poolContract,
            epochManagerContract,
            seniorTrancheVaultContract,
            juniorTrancheVaultContract,
            creditContract as unknown,
            creditDueManagerContract,
            creditManagerContract as unknown,
            internalReceivableContract,
        ] = await deployPoolContracts(
            humaConfigContract,
            usdc.address,
            "RiskAdjustedTranchesPolicy",
            defaultDeployer,
            poolOwner,
            "ReceivableFactoringCredit",
            "ReceivableLevelCreditManager",
        );
        await poolConfigContract
            .connect(poolOwner)
            .setReceivableAsset(internalReceivableContract.address);

        const SuperfluidProcessorContract = await ethers.getContractFactory("SuperfluidProcessor");
        sfProcessorContract = await SuperfluidProcessorContract.deploy();
        await sfProcessorContract.deployed();
        await sfProcessorContract["initialize(address,address,address,address)"](
            poolConfigContract.address,
            sfHostAddress,
            sfCFAAddress,
            sfNftContract.address,
        );
        await internalReceivableContract.createReceivable(0, 0, 0, "");
        await internalReceivableContract
            .connect(poolOwner)
            .grantRole(internalReceivableContract.MINTER_ROLE(), sfProcessorContract.address);
        await creditManagerContract
            .connect(poolOwner)
            .addRole(await creditManagerContract.APPROVER_ROLE(), sfProcessorContract.address);

        const poolLiquidityCap = toUSDC(1_000_000_000);
        await poolConfigContract.connect(poolOwner).setPoolLiquidityCap(poolLiquidityCap);
        await poolConfigContract.connect(poolOwner).setMaxCreditLine(toUSDC(10_000_000));

        await poolConfigContract
            .connect(poolOwner)
            .setPoolOwnerTreasury(poolOwnerTreasury.getAddress());

        let eaNFTTokenId;
        const tx = await eaNFTContract.mintNFT(evaluationAgent.address);
        const receipt = await tx.wait();
        for (const evt of receipt.events!) {
            if (evt.event === "NFTGenerated") {
                eaNFTTokenId = evt.args!.tokenId;
            }
        }
        await poolConfigContract
            .connect(poolOwner)
            .setEvaluationAgent(eaNFTTokenId, evaluationAgent.getAddress());

        // Deposit enough liquidity for the pool owner and EA in the junior tranche.
        const adminRnR = await poolConfigContract.getAdminRnR();
        await usdc
            .connect(poolOwnerTreasury)
            .approve(poolSafeContract.address, ethers.constants.MaxUint256);
        await mint(poolOwnerTreasury.address, toUSDC(1_000_000_000));
        const poolOwnerLiquidity = BN.from(adminRnR.liquidityRateInBpsByPoolOwner)
            .mul(poolLiquidityCap)
            .div(CONSTANTS.BP_FACTOR);
        await juniorTrancheVaultContract
            .connect(poolOwnerTreasury)
            .makeInitialDeposit(poolOwnerLiquidity);

        await usdc
            .connect(evaluationAgent)
            .approve(poolSafeContract.address, ethers.constants.MaxUint256);
        await mint(evaluationAgent.address, toUSDC(1_000_000_000));
        const evaluationAgentLiquidity = BN.from(adminRnR.liquidityRateInBpsByPoolOwner)
            .mul(poolLiquidityCap)
            .div(CONSTANTS.BP_FACTOR);
        await juniorTrancheVaultContract
            .connect(evaluationAgent)
            .makeInitialDeposit(evaluationAgentLiquidity);

        await usdc
            .connect(poolOwnerTreasury)
            .approve(affiliateFirstLossCoverContract.address, ethers.constants.MaxUint256);
        await usdc
            .connect(evaluationAgent)
            .approve(affiliateFirstLossCoverContract.address, ethers.constants.MaxUint256);
        const firstLossCoverageInBps = 100;
        await affiliateFirstLossCoverContract
            .connect(poolOwner)
            .setCoverProvider(poolOwnerTreasury.address, {
                poolCapCoverageInBps: firstLossCoverageInBps,
                poolValueCoverageInBps: firstLossCoverageInBps,
            });
        await affiliateFirstLossCoverContract
            .connect(poolOwner)
            .setCoverProvider(evaluationAgent.address, {
                poolCapCoverageInBps: firstLossCoverageInBps,
                poolValueCoverageInBps: firstLossCoverageInBps,
            });

        const role = await poolConfigContract.POOL_OPERATOR_ROLE();
        await poolConfigContract.connect(poolOwner).grantRole(role, poolOwner.getAddress());
        await poolConfigContract.connect(poolOwner).grantRole(role, poolOperator.getAddress());

        await juniorTrancheVaultContract
            .connect(poolOperator)
            .setReinvestYield(poolOwnerTreasury.address, true);
        await juniorTrancheVaultContract
            .connect(poolOperator)
            .setReinvestYield(evaluationAgent.address, true);

        await affiliateFirstLossCoverContract
            .connect(poolOwnerTreasury)
            .depositCover(poolLiquidityCap.mul(firstLossCoverageInBps).div(CONSTANTS.BP_FACTOR));
        await affiliateFirstLossCoverContract
            .connect(evaluationAgent)
            .depositCover(poolLiquidityCap.mul(firstLossCoverageInBps).div(CONSTANTS.BP_FACTOR));

        await poolContract.connect(poolOwner).enablePool();

        await mint(borrower.address, toUSDC(1_000_000_000));
        await poolConfigContract
            .connect(poolOwner)
            .setFirstLossCover(
                CONSTANTS.BORROWER_FIRST_LOSS_COVER_INDEX,
                ethers.constants.AddressZero,
                {
                    coverRateInBps: 0,
                    coverCap: 0,
                    liquidityCap: 0,
                    maxPercentOfPoolValueInBps: 0,
                    riskYieldMultiplier: 0,
                },
            );
        await creditContract.connect(poolOwner).updatePoolConfigData();

        await juniorTrancheVaultContract
            .connect(poolOperator)
            .addApprovedLender(lender.address, true);
        await usdc.connect(lender).approve(poolSafeContract.address, ethers.constants.MaxUint256);
        await juniorTrancheVaultContract
            .connect(lender)
            .deposit(toToken(10_000_000), lender.address);

        await poolConfigContract
            .connect(poolOwner)
            .setPoolPayPeriod(CONSTANTS.PERIOD_DURATION_MONTHLY);

        await poolConfigContract
            .connect(poolOwner)
            .setLatePaymentGracePeriodInDays(lateGracePeriodInDays);

        await poolConfigContract.connect(poolOwner).setFeeStructure({
            yieldInBps: yieldInBps,
            minPrincipalRateInBps: principalRate,
            lateFeeFlat: lateFeeFlat,
            lateFeeBps: lateFeeBps,
            membershipFee: membershipFee,
        });

        console.log("prepareForSFFlow...");
        await prepareForSFFlow();
        console.log("prepareForSFFlow is done.");
    }

    let streamAmount: number,
        streamDays: number,
        streamDuration: number,
        collateralAmount: number,
        loanAmountInDefault: number,
        loanAmount: BN,
        streamId: number,
        nftVersion: string;

    async function prepareForSFFlow() {
        await usdcx.connect(payer).upgrade(toDefaultToken(10_000));

        streamAmount = 6000;
        streamDays = 28;
        streamDuration = streamDays * 24 * 60 * 60;

        let flowrate = toDefaultToken(streamAmount).div(BN.from(streamDuration));
        await createFlow(usdcx, payer, borrower, flowrate);
        console.log("SF flow is created.");

        await authorizeFlow(usdcx, payer, sfNftContract.address);
        console.log("SF flow is authorized.");

        const block = await ethers.provider.getBlock("latest");
        let nextTime = timestampToMoment(block.timestamp, "YYYY-MM-01").add(1, "months").unix();
        await setNextBlockTimestamp(nextTime);
        console.log(`SF NFT start time: ${nextTime}`);

        collateralAmount = 1500;
        flowrate = toDefaultToken(collateralAmount).div(BN.from(streamDuration)).add(BN.from(1));
        await sfNftContract
            .connect(borrower)
            .mint(usdcx.address, payer.address, flowrate, streamDuration);
        console.log("SF NFT is minted.");
        streamId = 0;

        nftVersion = await sfNftContract.version();
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    describe("approveCredit", function () {
        it("Should approve stream with amount equals to or high than the receivable requirement", async function () {
            await sfProcessorContract
                .connect(eaServiceAccount)
                .approveTradableStream(borrower.address, toUSDC(streamAmount), 1, yieldInBps, {
                    receivableAsset: sfNftContract.address,
                    receivableAmount: toUSDC(streamAmount),
                    receivableParam: ethers.utils.solidityKeccak256(
                        ["address", "address", "address"],
                        [usdcx.address, payer.address, borrower.address],
                    ),
                });

            // let res = await poolContract.receivableInfoMapping(borrower.address);
            // checkResults(res, [
            //     nftContract.address,
            //     toUSDC(streamAmount),
            //     ethers.utils.solidityKeccak256(
            //         ["address", "address", "address"],
            //         [usdcx.address, payer.address, borrower.address],
            //     ),
            // ]);
            // res = await poolContract.creditRecordStaticMapping(borrower.address);
            // checkResults(res, [toUSDC(streamAmount), 1217, streamDays, 0]);
        });
    });

    describe("mintTo & drawdown", function () {
        beforeEach(async function () {
            await sfProcessorContract
                .connect(eaServiceAccount)
                .approveTradableStream(borrower.address, toUSDC(streamAmount), 1, yieldInBps, {
                    receivableAsset: sfNftContract.address,
                    receivableAmount: toUSDC(streamAmount),
                    receivableParam: ethers.utils.solidityKeccak256(
                        ["address", "address", "address"],
                        [usdcx.address, payer.address, borrower.address],
                    ),
                });
        });

        // it("Should revert when receivableAssets mismatched", async function () {
        //     await expect(
        //         poolProcessorContract.mintAndDrawdown(
        //             borrower.address,
        //             toUSDC(100),
        //             ethers.constants.AddressZero,
        //             "0x",
        //         ),
        //     ).to.be.revertedWithCustomError(poolProcessorContract, "receivableAssetMismatch");
        // });

        // it("Should revert when borrower mismatched receiver", async function () {
        //     let flowrate = toDefaultToken(collateralAmount)
        //         .div(BN.from(streamDuration))
        //         .add(BN.from(1));
        //     loanAmount = convertDefaultToUSDC(flowrate.mul(streamDuration));
        //     const nonce = await nftContract.nonces(borrower.address);
        //     const expiry = Math.ceil(Date.now() / 1000) + 300;

        //     const signatureData = await borrower._signTypedData(
        //         {
        //             name: "TradableStream",
        //             version: nftVersion,
        //             chainId: HARDHAT_CHAIN_ID,
        //             verifyingContract: nftContract.address,
        //         },
        //         {
        //             MintToWithAuthorization: [
        //                 { name: "receiver", type: "address" },
        //                 { name: "token", type: "address" },
        //                 { name: "origin", type: "address" },
        //                 { name: "owner", type: "address" },
        //                 { name: "flowrate", type: "int96" },
        //                 { name: "durationInSeconds", type: "uint256" },
        //                 { name: "nonce", type: "uint256" },
        //                 { name: "expiry", type: "uint256" },
        //             ],
        //         },
        //         {
        //             receiver: borrower.address,
        //             token: usdcx.address,
        //             origin: payer.address,
        //             owner: poolProcessorContract.address,
        //             flowrate: flowrate,
        //             durationInSeconds: streamDuration,
        //             nonce: nonce,
        //             expiry: expiry,
        //         },
        //     );
        //     const signature = ethers.utils.splitSignature(signatureData);

        //     const calldata = ethers.utils.defaultAbiCoder.encode(
        //         [
        //             "address",
        //             "address",
        //             "address",
        //             "int96",
        //             "uint256",
        //             "uint256",
        //             "uint8",
        //             "bytes32",
        //             "bytes32",
        //         ],
        //         [
        //             nftContract.address,
        //             usdcx.address,
        //             payer.address,
        //             flowrate,
        //             streamDuration,
        //             expiry,
        //             signature.v,
        //             signature.r,
        //             signature.s,
        //         ],
        //     );

        //     await expect(
        //         poolProcessorContract.mintAndDrawdown(
        //             borrower.address,
        //             loanAmount,
        //             nftContract.address,
        //             calldata,
        //         ),
        //     ).to.be.revertedWithCustomError(poolProcessorContract, "borrowerMismatch");
        // });

        // it("Should revert when receivableParam mismatched", async function () {
        //     let flowrate = toDefaultToken(collateralAmount)
        //         .div(BN.from(streamDuration))
        //         .add(BN.from(1));
        //     loanAmount = convertDefaultToUSDC(flowrate.mul(streamDuration));
        //     const nonce = await nftContract.nonces(borrower.address);
        //     const expiry = Math.ceil(Date.now() / 1000) + 300;

        //     const signatureData = await borrower._signTypedData(
        //         {
        //             name: "TradableStream",
        //             version: nftVersion,
        //             chainId: HARDHAT_CHAIN_ID,
        //             verifyingContract: nftContract.address,
        //         },
        //         {
        //             MintToWithAuthorization: [
        //                 { name: "receiver", type: "address" },
        //                 { name: "token", type: "address" },
        //                 { name: "origin", type: "address" },
        //                 { name: "owner", type: "address" },
        //                 { name: "flowrate", type: "int96" },
        //                 { name: "durationInSeconds", type: "uint256" },
        //                 { name: "nonce", type: "uint256" },
        //                 { name: "expiry", type: "uint256" },
        //             ],
        //         },
        //         {
        //             receiver: borrower.address,
        //             token: usdcx.address,
        //             origin: payer.address,
        //             owner: poolProcessorContract.address,
        //             flowrate: flowrate,
        //             durationInSeconds: streamDuration,
        //             nonce: nonce,
        //             expiry: expiry,
        //         },
        //     );
        //     const signature = ethers.utils.splitSignature(signatureData);

        //     const calldata = ethers.utils.defaultAbiCoder.encode(
        //         [
        //             "address",
        //             "address",
        //             "address",
        //             "int96",
        //             "uint256",
        //             "uint256",
        //             "uint8",
        //             "bytes32",
        //             "bytes32",
        //         ],
        //         [
        //             borrower.address,
        //             usdcx.address,
        //             ethers.constants.AddressZero,
        //             flowrate,
        //             streamDuration,
        //             expiry,
        //             signature.v,
        //             signature.r,
        //             signature.s,
        //         ],
        //     );

        //     await expect(
        //         poolProcessorContract.mintAndDrawdown(
        //             borrower.address,
        //             loanAmount,
        //             nftContract.address,
        //             calldata,
        //         ),
        //     ).to.be.revertedWithCustomError(poolContract, "receivableAssetParamMismatch");
        // });

        // it("Should revert when flowrate was invalid", async function () {
        //     let flowrate = toDefaultToken(collateralAmount)
        //         .div(BN.from(streamDuration))
        //         .add(BN.from(1));
        //     loanAmount = convertDefaultToUSDC(flowrate.mul(streamDuration));
        //     const nonce = await nftContract.nonces(borrower.address);
        //     const expiry = Math.ceil(Date.now() / 1000) + 300;

        //     const signatureData = await borrower._signTypedData(
        //         {
        //             name: "TradableStream",
        //             version: nftVersion,
        //             chainId: HARDHAT_CHAIN_ID,
        //             verifyingContract: nftContract.address,
        //         },
        //         {
        //             MintToWithAuthorization: [
        //                 { name: "receiver", type: "address" },
        //                 { name: "token", type: "address" },
        //                 { name: "origin", type: "address" },
        //                 { name: "owner", type: "address" },
        //                 { name: "flowrate", type: "int96" },
        //                 { name: "durationInSeconds", type: "uint256" },
        //                 { name: "nonce", type: "uint256" },
        //                 { name: "expiry", type: "uint256" },
        //             ],
        //         },
        //         {
        //             receiver: borrower.address,
        //             token: usdcx.address,
        //             origin: payer.address,
        //             owner: poolProcessorContract.address,
        //             flowrate: flowrate,
        //             durationInSeconds: streamDuration,
        //             nonce: nonce,
        //             expiry: expiry,
        //         },
        //     );
        //     const signature = ethers.utils.splitSignature(signatureData);

        //     const calldata = ethers.utils.defaultAbiCoder.encode(
        //         [
        //             "address",
        //             "address",
        //             "address",
        //             "int96",
        //             "uint256",
        //             "uint256",
        //             "uint8",
        //             "bytes32",
        //             "bytes32",
        //         ],
        //         [
        //             borrower.address,
        //             usdcx.address,
        //             payer.address,
        //             0,
        //             streamDuration,
        //             expiry,
        //             signature.v,
        //             signature.r,
        //             signature.s,
        //         ],
        //     );

        //     await expect(
        //         poolProcessorContract.mintAndDrawdown(
        //             borrower.address,
        //             loanAmount,
        //             nftContract.address,
        //             calldata,
        //         ),
        //     ).to.be.revertedWithCustomError(poolProcessorContract, "invalidFlowrate");
        // });

        // it("Should revert when duration was too long", async function () {
        //     let flowrate = toDefaultToken(collateralAmount)
        //         .div(BN.from(streamDuration))
        //         .add(BN.from(1));
        //     loanAmount = convertDefaultToUSDC(flowrate.mul(streamDuration));
        //     const nonce = await nftContract.nonces(borrower.address);
        //     const expiry = Math.ceil(Date.now() / 1000) + 300;

        //     const signatureData = await borrower._signTypedData(
        //         {
        //             name: "TradableStream",
        //             version: nftVersion,
        //             chainId: HARDHAT_CHAIN_ID,
        //             verifyingContract: nftContract.address,
        //         },
        //         {
        //             MintToWithAuthorization: [
        //                 { name: "receiver", type: "address" },
        //                 { name: "token", type: "address" },
        //                 { name: "origin", type: "address" },
        //                 { name: "owner", type: "address" },
        //                 { name: "flowrate", type: "int96" },
        //                 { name: "durationInSeconds", type: "uint256" },
        //                 { name: "nonce", type: "uint256" },
        //                 { name: "expiry", type: "uint256" },
        //             ],
        //         },
        //         {
        //             receiver: borrower.address,
        //             token: usdcx.address,
        //             origin: payer.address,
        //             owner: poolProcessorContract.address,
        //             flowrate: flowrate,
        //             durationInSeconds: streamDuration,
        //             nonce: nonce,
        //             expiry: expiry,
        //         },
        //     );
        //     const signature = ethers.utils.splitSignature(signatureData);

        //     const calldata = ethers.utils.defaultAbiCoder.encode(
        //         [
        //             "address",
        //             "address",
        //             "address",
        //             "int96",
        //             "uint256",
        //             "uint256",
        //             "uint8",
        //             "bytes32",
        //             "bytes32",
        //         ],
        //         [
        //             borrower.address,
        //             usdcx.address,
        //             payer.address,
        //             flowrate,
        //             streamDuration + 1,
        //             expiry,
        //             signature.v,
        //             signature.r,
        //             signature.s,
        //         ],
        //     );

        //     await expect(
        //         poolProcessorContract.mintAndDrawdown(
        //             borrower.address,
        //             loanAmount,
        //             nftContract.address,
        //             calldata,
        //         ),
        //     ).to.be.revertedWithCustomError(poolProcessorContract, "durationTooLong");
        // });

        // it("Should revert when there was no enough receivable amount", async function () {
        //     let flowrate = toDefaultToken(collateralAmount)
        //         .div(BN.from(streamDuration))
        //         .add(BN.from(1));
        //     loanAmount = convertDefaultToUSDC(flowrate.mul(streamDuration));
        //     const nonce = await nftContract.nonces(borrower.address);
        //     const expiry = Math.ceil(Date.now() / 1000) + 300;

        //     const signatureData = await borrower._signTypedData(
        //         {
        //             name: "TradableStream",
        //             version: nftVersion,
        //             chainId: HARDHAT_CHAIN_ID,
        //             verifyingContract: nftContract.address,
        //         },
        //         {
        //             MintToWithAuthorization: [
        //                 { name: "receiver", type: "address" },
        //                 { name: "token", type: "address" },
        //                 { name: "origin", type: "address" },
        //                 { name: "owner", type: "address" },
        //                 { name: "flowrate", type: "int96" },
        //                 { name: "durationInSeconds", type: "uint256" },
        //                 { name: "nonce", type: "uint256" },
        //                 { name: "expiry", type: "uint256" },
        //             ],
        //         },
        //         {
        //             receiver: borrower.address,
        //             token: usdcx.address,
        //             origin: payer.address,
        //             owner: poolProcessorContract.address,
        //             flowrate: flowrate,
        //             durationInSeconds: streamDuration,
        //             nonce: nonce,
        //             expiry: expiry,
        //         },
        //     );
        //     const signature = ethers.utils.splitSignature(signatureData);

        //     const calldata = ethers.utils.defaultAbiCoder.encode(
        //         [
        //             "address",
        //             "address",
        //             "address",
        //             "int96",
        //             "uint256",
        //             "uint256",
        //             "uint8",
        //             "bytes32",
        //             "bytes32",
        //         ],
        //         [
        //             borrower.address,
        //             usdcx.address,
        //             payer.address,
        //             flowrate.div(2),
        //             streamDuration,
        //             expiry,
        //             signature.v,
        //             signature.r,
        //             signature.s,
        //         ],
        //     );

        //     await expect(
        //         poolProcessorContract.mintAndDrawdown(
        //             borrower.address,
        //             loanAmount,
        //             nftContract.address,
        //             calldata,
        //         ),
        //     ).to.be.revertedWithCustomError(poolProcessorContract, "insufficientReceivableAmount");
        // });

        // it("Should revert when allowance was too low", async function () {
        //     let flowrate = toDefaultToken(collateralAmount)
        //         .div(BN.from(streamDuration))
        //         .add(BN.from(1));
        //     loanAmount = convertDefaultToUSDC(flowrate.mul(streamDuration));
        //     const nonce = await nftContract.nonces(borrower.address);
        //     const expiry = Math.ceil(Date.now() / 1000) + 300;

        //     const signatureData = await borrower._signTypedData(
        //         {
        //             name: "TradableStream",
        //             version: nftVersion,
        //             chainId: HARDHAT_CHAIN_ID,
        //             verifyingContract: nftContract.address,
        //         },
        //         {
        //             MintToWithAuthorization: [
        //                 { name: "receiver", type: "address" },
        //                 { name: "token", type: "address" },
        //                 { name: "origin", type: "address" },
        //                 { name: "owner", type: "address" },
        //                 { name: "flowrate", type: "int96" },
        //                 { name: "durationInSeconds", type: "uint256" },
        //                 { name: "nonce", type: "uint256" },
        //                 { name: "expiry", type: "uint256" },
        //             ],
        //         },
        //         {
        //             receiver: borrower.address,
        //             token: usdcx.address,
        //             origin: payer.address,
        //             owner: poolProcessorContract.address,
        //             flowrate: flowrate,
        //             durationInSeconds: streamDuration,
        //             nonce: nonce,
        //             expiry: expiry,
        //         },
        //     );
        //     const signature = ethers.utils.splitSignature(signatureData);

        //     const calldata = ethers.utils.defaultAbiCoder.encode(
        //         [
        //             "address",
        //             "address",
        //             "address",
        //             "int96",
        //             "uint256",
        //             "uint256",
        //             "uint8",
        //             "bytes32",
        //             "bytes32",
        //         ],
        //         [
        //             borrower.address,
        //             usdcx.address,
        //             payer.address,
        //             flowrate,
        //             streamDuration,
        //             expiry,
        //             signature.v,
        //             signature.r,
        //             signature.s,
        //         ],
        //     );

        //     await expect(
        //         poolProcessorContract.mintAndDrawdown(
        //             borrower.address,
        //             loanAmount,
        //             nftContract.address,
        //             calldata,
        //         ),
        //     ).to.be.revertedWithCustomError(poolProcessorContract, "allowanceTooLow");
        // });

        // it("Should revert when authorization expired", async function () {
        //     await usdc.connect(borrower).approve(poolProcessorContract.address, toUSDC(10_000));

        //     let flowrate = toDefaultToken(collateralAmount)
        //         .div(BN.from(streamDuration))
        //         .add(BN.from(1));
        //     loanAmount = convertDefaultToUSDC(flowrate.mul(streamDuration));
        //     const nonce = await nftContract.nonces(borrower.address);
        //     const expiry = Math.ceil(Date.now() / 1000) + 300;

        //     const signatureData = await borrower._signTypedData(
        //         {
        //             name: "TradableStream",
        //             version: nftVersion,
        //             chainId: HARDHAT_CHAIN_ID,
        //             verifyingContract: nftContract.address,
        //         },
        //         {
        //             MintToWithAuthorization: [
        //                 { name: "receiver", type: "address" },
        //                 { name: "token", type: "address" },
        //                 { name: "origin", type: "address" },
        //                 { name: "owner", type: "address" },
        //                 { name: "flowrate", type: "int96" },
        //                 { name: "durationInSeconds", type: "uint256" },
        //                 { name: "nonce", type: "uint256" },
        //                 { name: "expiry", type: "uint256" },
        //             ],
        //         },
        //         {
        //             receiver: borrower.address,
        //             token: usdcx.address,
        //             origin: payer.address,
        //             owner: poolProcessorContract.address,
        //             flowrate: flowrate,
        //             durationInSeconds: streamDuration,
        //             nonce: nonce,
        //             expiry: expiry,
        //         },
        //     );
        //     const signature = ethers.utils.splitSignature(signatureData);

        //     let block = await ethers.provider.getBlock();

        //     const calldata = ethers.utils.defaultAbiCoder.encode(
        //         [
        //             "address",
        //             "address",
        //             "address",
        //             "int96",
        //             "uint256",
        //             "uint256",
        //             "uint8",
        //             "bytes32",
        //             "bytes32",
        //         ],
        //         [
        //             borrower.address,
        //             usdcx.address,
        //             payer.address,
        //             flowrate,
        //             streamDuration,
        //             block.timestamp,
        //             signature.v,
        //             signature.r,
        //             signature.s,
        //         ],
        //     );

        //     await expect(
        //         poolProcessorContract.mintAndDrawdown(
        //             borrower.address,
        //             loanAmount,
        //             nftContract.address,
        //             calldata,
        //         ),
        //     ).to.be.revertedWithCustomError(nftContract, "AuthorizationExpired");
        // });

        // it("Should revert when authorization was invalid", async function () {
        //     await usdc.connect(borrower).approve(poolProcessorContract.address, toUSDC(10_000));

        //     let flowrate = toDefaultToken(collateralAmount)
        //         .div(BN.from(streamDuration))
        //         .add(BN.from(1));
        //     loanAmount = convertDefaultToUSDC(flowrate.mul(streamDuration));
        //     const nonce = await nftContract.nonces(borrower.address);
        //     const expiry = Math.ceil(Date.now() / 1000) + 300;

        //     const signatureData = await borrower._signTypedData(
        //         {
        //             name: "TradableStream",
        //             version: nftVersion,
        //             chainId: HARDHAT_CHAIN_ID,
        //             verifyingContract: nftContract.address,
        //         },
        //         {
        //             MintToWithAuthorization: [
        //                 { name: "receiver", type: "address" },
        //                 { name: "token", type: "address" },
        //                 { name: "origin", type: "address" },
        //                 { name: "owner", type: "address" },
        //                 { name: "flowrate", type: "int96" },
        //                 { name: "durationInSeconds", type: "uint256" },
        //                 { name: "nonce", type: "uint256" },
        //                 { name: "expiry", type: "uint256" },
        //             ],
        //         },
        //         {
        //             receiver: borrower.address,
        //             token: usdcx.address,
        //             origin: payer.address,
        //             owner: poolProcessorContract.address,
        //             flowrate: flowrate,
        //             durationInSeconds: streamDuration + 1,
        //             nonce: nonce,
        //             expiry: expiry,
        //         },
        //     );
        //     const signature = ethers.utils.splitSignature(signatureData);

        //     let block = await ethers.provider.getBlock();

        //     const calldata = ethers.utils.defaultAbiCoder.encode(
        //         [
        //             "address",
        //             "address",
        //             "address",
        //             "int96",
        //             "uint256",
        //             "uint256",
        //             "uint8",
        //             "bytes32",
        //             "bytes32",
        //         ],
        //         [
        //             borrower.address,
        //             usdcx.address,
        //             payer.address,
        //             flowrate,
        //             streamDuration,
        //             expiry,
        //             signature.v,
        //             signature.r,
        //             signature.s,
        //         ],
        //     );

        //     await expect(
        //         poolProcessorContract.mintAndDrawdown(
        //             borrower.address,
        //             loanAmount,
        //             nftContract.address,
        //             calldata,
        //         ),
        //     ).to.be.revertedWithCustomError(nftContract, "InvalidAuthorization");
        // });

        it("Should drawdown with authorization", async function () {
            await usdc.connect(borrower).approve(sfProcessorContract.address, toUSDC(10_000));

            // const beforeAmount = await usdc.balanceOf(borrower.address);
            // const beforeProcessorFlowrate = await cfa.getNetFlow(
            //     usdcx.address,
            //     poolProcessorContract.address,
            // );
            // const beforeBorrowerFlowrate = await cfa.getNetFlow(usdcx.address, borrower.address);

            const ts = await getFutureBlockTime(2);
            await setNextBlockTimestamp(ts);

            let flowrate = toDefaultToken(collateralAmount)
                .div(BN.from(streamDuration))
                .add(BN.from(1));
            loanAmount = convertDefaultToUSDC(flowrate.mul(streamDuration));
            const nonce = await sfNftContract.nonces(borrower.address);
            const expiry = ts + 300;

            const signatureData = await borrower._signTypedData(
                {
                    name: "TradableStream",
                    version: nftVersion,
                    chainId: HARDHAT_CHAIN_ID,
                    verifyingContract: sfNftContract.address,
                },
                {
                    MintToWithAuthorization: [
                        { name: "receiver", type: "address" },
                        { name: "token", type: "address" },
                        { name: "origin", type: "address" },
                        { name: "owner", type: "address" },
                        { name: "flowrate", type: "int96" },
                        { name: "durationInSeconds", type: "uint256" },
                        { name: "nonce", type: "uint256" },
                        { name: "expiry", type: "uint256" },
                    ],
                },
                {
                    receiver: borrower.address,
                    token: usdcx.address,
                    origin: payer.address,
                    owner: sfProcessorContract.address,
                    flowrate: flowrate,
                    durationInSeconds: streamDuration,
                    nonce: nonce,
                    expiry: expiry,
                },
            );
            const signature = ethers.utils.splitSignature(signatureData);

            const calldata = ethers.utils.defaultAbiCoder.encode(
                [
                    "address",
                    "address",
                    "address",
                    "int96",
                    "uint256",
                    "uint256",
                    "uint8",
                    "bytes32",
                    "bytes32",
                ],
                [
                    borrower.address,
                    usdcx.address,
                    payer.address,
                    flowrate,
                    streamDuration,
                    expiry,
                    signature.v,
                    signature.r,
                    signature.s,
                ],
            );

            await sfProcessorContract.mintAndDrawdown(
                borrower.address,
                loanAmount,
                sfNftContract.address,
                calldata,
            );

            // const streamId = 1;
            // const interest = loanAmount.mul(BN.from(streamDays * 1217)).div(BN.from(365 * 10000));
            // const flowId = ethers.utils.keccak256(
            //     ethers.utils.defaultAbiCoder.encode(
            //         ["address", "address"],
            //         [payer.address, poolProcessorContract.address],
            //     ),
            // );
            // const flowKey = ethers.utils.solidityKeccak256(
            //     ["address", "bytes32"],
            //     [usdcx.address, flowId],
            // );
            // await expect(
            //     poolProcessorContract.mintAndDrawdown(
            //         borrower.address,
            //         loanAmount,
            //         nftContract.address,
            //         calldata,
            //     ),
            // )
            //     .to.emit(poolProcessorContract, "ReceivableFlowKey")
            //     .withArgs(poolContract.address, borrower.address, streamId, flowKey)
            //     .to.emit(poolProcessorContract, "DrawdownMadeWithReceivable")
            //     .withArgs(
            //         poolContract.address,
            //         borrower.address,
            //         loanAmount,
            //         loanAmount.sub(interest),
            //         nftContract.address,
            //         streamId,
            //     );

            // const afterAmount = await usdc.balanceOf(borrower.address);
            // const afterProcessorFlowrate = await cfa.getNetFlow(
            //     usdcx.address,
            //     poolProcessorContract.address,
            // );
            // const afterBorrowerFlowrate = await cfa.getNetFlow(usdcx.address, borrower.address);
            // const receivedAmount = afterAmount.sub(beforeAmount);

            // expect(receivedAmount).to.equal(loanAmount.sub(interest));
            // expect(await nftContract.ownerOf(streamId)).to.equal(poolProcessorContract.address);
            // expect(beforeBorrowerFlowrate.sub(afterBorrowerFlowrate)).to.equal(
            //     afterProcessorFlowrate.sub(beforeProcessorFlowrate),
            // );

            // let res = await nftContract.getTradableStreamData(streamId);
            // flowrate = res[6];
            // expect(afterProcessorFlowrate.sub(beforeProcessorFlowrate)).to.equal(flowrate);

            // res = await poolProcessorContract.streamInfoMapping(streamId);
            // const dueDate = ts + streamDuration;
            // checkResults(res, [
            //     borrower.address,
            //     flowrate,
            //     usdcx.address,
            //     ts,
            //     dueDate,
            //     0,
            //     flowKey,
            // ]);
            // const cr = await poolContract.creditRecordMapping(borrower.address);
            // const crs = await poolContract.creditRecordStaticMapping(borrower.address);
            // // printRecord(cr, crs);
            // checkRecord(
            //     cr,
            //     crs,
            //     toUSDC(streamAmount),
            //     0,
            //     dueDate,
            //     0,
            //     loanAmount,
            //     0,
            //     0,
            //     0,
            //     1217,
            //     streamDays,
            //     3,
            //     0,
            // );
        });
    });
});
