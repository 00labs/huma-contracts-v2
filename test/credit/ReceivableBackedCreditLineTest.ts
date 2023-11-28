// import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
// import { expect } from "chai";
// import { BigNumber as BN } from "ethers";
// import { ethers } from "hardhat";
// import {
//     Calendar,
//     CreditDueManager,
//     EpochManager,
//     EvaluationAgentNFT,
//     FirstLossCover,
//     HumaConfig,
//     MockToken,
//     Pool,
//     PoolConfig,
//     PoolFeeManager,
//     PoolSafe,
//     Receivable,
//     ReceivableBackedCreditLine,
//     RiskAdjustedTranchesPolicy,
//     TrancheVault,
// } from "../../typechain-types";
// import {
//     CONSTANTS,
//     calcLateFeeNew,
//     deployAndSetupPoolContracts,
//     deployProtocolContracts,
//     printCreditRecord,
// } from "../BaseTest";
// import {
//     evmRevert,
//     evmSnapshot,
//     getLatestBlock,
//     getMinFirstLossCoverRequirement,
//     mineNextBlockWithTimestamp,
//     setNextBlockTimestamp,
//     timestampToMoment,
//     toToken,
// } from "../TestUtils";
//
// let defaultDeployer: SignerWithAddress,
//     protocolOwner: SignerWithAddress,
//     treasury: SignerWithAddress,
//     eaServiceAccount: SignerWithAddress,
//     pdsServiceAccount: SignerWithAddress;
// let poolOwner: SignerWithAddress,
//     poolOwnerTreasury: SignerWithAddress,
//     evaluationAgent: SignerWithAddress,
//     poolOperator: SignerWithAddress;
// let lender: SignerWithAddress, borrower: SignerWithAddress;
//
// let eaNFTContract: EvaluationAgentNFT,
//     humaConfigContract: HumaConfig,
//     mockTokenContract: MockToken;
// let poolConfigContract: PoolConfig,
//     poolFeeManagerContract: PoolFeeManager,
//     poolSafeContract: PoolSafe,
//     calendarContract: Calendar,
//     borrowerFirstLossCoverContract: FirstLossCover,
//     affiliateFirstLossCoverContract: FirstLossCover,
//     tranchesPolicyContract: RiskAdjustedTranchesPolicy,
//     poolContract: Pool,
//     epochManagerContract: EpochManager,
//     seniorTrancheVaultContract: TrancheVault,
//     juniorTrancheVaultContract: TrancheVault,
//     creditContract: ReceivableBackedCreditLine,
//     creditDueManagerContract: CreditDueManager,
//     receivableContract: Receivable;
//
// describe("ReceivableBackedCreditLine Tests", function () {
//     async function prepare() {
//         [eaNFTContract, humaConfigContract, mockTokenContract] = await deployProtocolContracts(
//             protocolOwner,
//             treasury,
//             eaServiceAccount,
//             pdsServiceAccount,
//             poolOwner,
//         );
//
//         [
//             poolConfigContract,
//             poolFeeManagerContract,
//             poolSafeContract,
//             calendarContract,
//             borrowerFirstLossCoverContract,
//             affiliateFirstLossCoverContract,
//             tranchesPolicyContract,
//             poolContract,
//             epochManagerContract,
//             seniorTrancheVaultContract,
//             juniorTrancheVaultContract,
//             creditContract as unknown,
//             creditDueManagerContract,
//         ] = await deployAndSetupPoolContracts(
//             humaConfigContract,
//             mockTokenContract,
//             eaNFTContract,
//             "RiskAdjustedTranchesPolicy",
//             defaultDeployer,
//             poolOwner,
//             "ReceivableBackedCreditLine",
//             evaluationAgent,
//             poolOwnerTreasury,
//             poolOperator,
//             [lender, borrower],
//         );
//
//         const Receivable = await ethers.getContractFactory("Receivable");
//         receivableContract = await Receivable.deploy();
//         await receivableContract.deployed();
//
//         await receivableContract.connect(poolOwner).initialize();
//         await receivableContract
//             .connect(poolOwner)
//             .grantRole(receivableContract.MINTER_ROLE(), borrower.address);
//         await poolConfigContract.connect(poolOwner).setReceivableAsset(receivableContract.address);
//
//         await borrowerFirstLossCoverContract
//             .connect(poolOwner)
//             .setCoverProvider(borrower.address, {
//                 poolCapCoverageInBps: 1,
//                 poolValueCoverageInBps: 100,
//             });
//         await mockTokenContract
//             .connect(borrower)
//             .approve(borrowerFirstLossCoverContract.address, ethers.constants.MaxUint256);
//         await borrowerFirstLossCoverContract
//             .connect(borrower)
//             .depositCover(
//                 (
//                     await getMinFirstLossCoverRequirement(
//                         borrowerFirstLossCoverContract,
//                         poolConfigContract,
//                         poolContract,
//                         borrower.address,
//                     )
//                 ).mul(2),
//             );
//
//         await juniorTrancheVaultContract
//             .connect(lender)
//             .deposit(toToken(10_000_000), lender.address);
//     }
//     before(async function () {
//         [
//             defaultDeployer,
//             protocolOwner,
//             treasury,
//             eaServiceAccount,
//             pdsServiceAccount,
//             poolOwner,
//             poolOwnerTreasury,
//             evaluationAgent,
//             poolOperator,
//             lender,
//             borrower,
//         ] = await ethers.getSigners();
//     });
//
//     describe("Arf case tests", function () {
//         let creditHash: string;
//         let borrowAmount: BN, paymentAmount: BN;
//         let creditLimit: BN;
//         const yieldInBps = 1200;
//         const lateFeeBps = 2400;
//         const lateFeeFlat = 0;
//         const principalRate = 0;
//         const membershipFee = 0;
//         const lateGracePeriodInDays = 5;
//         let advanceRate: BN;
//         async function prepareForArfTests() {
//             creditHash = ethers.utils.keccak256(
//                 ethers.utils.defaultAbiCoder.encode(
//                     ["address", "address"],
//                     [creditContract.address, borrower.address],
//                 ),
//             );
//
//             borrowAmount = toToken(1_000_000);
//             paymentAmount = borrowAmount;
//             creditLimit = borrowAmount
//                 .mul(5)
//                 .mul(CONSTANTS.BP_FACTOR.add(500))
//                 .div(CONSTANTS.BP_FACTOR);
//             advanceRate = CONSTANTS.BP_FACTOR;
//
//             await poolConfigContract
//                 .connect(poolOwner)
//                 .setPoolPayPeriod(CONSTANTS.PERIOD_DURATION_MONTHLY);
//             await poolConfigContract
//                 .connect(poolOwner)
//                 .setLatePaymentGracePeriodInDays(lateGracePeriodInDays);
//             await poolConfigContract.connect(poolOwner).setAdvanceRateInBps(advanceRate);
//             await poolConfigContract.connect(poolOwner).setReceivableAutoApproval(true);
//
//             await poolConfigContract.connect(poolOwner).setFeeStructure({
//                 yieldInBps: yieldInBps,
//                 minPrincipalRateInBps: principalRate,
//                 lateFeeFlat: lateFeeFlat,
//                 lateFeeBps: lateFeeBps,
//                 membershipFee: membershipFee,
//             });
//         }
//
//         let sId: unknown;
//
//         before(async function () {
//             await prepare();
//             await prepareForArfTests();
//             sId = await evmSnapshot();
//         });
//
//         after(async function () {
//             if (sId) {
//                 await evmRevert(sId);
//             }
//         });
//
//         let nextTime: number;
//         it("approve borrower credit", async function () {
//             let poolSettings = await poolConfigContract.getPoolSettings();
//
//             await creditContract
//                 .connect(eaServiceAccount)
//                 .approveBorrower(
//                     borrower.address,
//                     creditLimit,
//                     24,
//                     yieldInBps,
//                     borrowAmount,
//                     true,
//                 );
//
//             // let creditConfig = await creditContract.getCreditConfig(creditHash);
//             // checkCreditConfig(
//             //     creditConfig,
//             //     creditLimit,
//             //     toToken(10_000),
//             //     poolSettings.payPeriodDuration,
//             //     1,
//             //     1217,
//             //     true,
//             //     false,
//             //     false,
//             //     false,
//             // );
//
//             // let creditRecord = await creditContract.getCreditRecord(creditHash);
//             // checkCreditRecord(
//             //     creditRecord,
//             //     BN.from(0),
//             //     0,
//             //     BN.from(0),
//             //     BN.from(0),
//             //     BN.from(0),
//             //     0,
//             //     1,
//             //     2,
//             // );
//             // expect(await creditContract.creditBorrowerMap(creditHash)).to.equal(borrower.address);
//         });
//
//         it("Month1 - Day1 ~ Day5: drawdown in the first week", async function () {
//             await receivableContract.connect(poolOwner).createReceivable(1, 0, 0, "");
//             let block = await getLatestBlock();
//             nextTime =
//                 (
//                     await calendarContract.getStartDateOfNextPeriod(
//                         CONSTANTS.PERIOD_DURATION_MONTHLY,
//                         block.timestamp,
//                     )
//                 ).toNumber() -
//                 3600 * 24 +
//                 100;
//
//             // Day1 - Day5 loop
//             for (let i = 0; i < 5; i++) {
//                 // move forward 1 day
//                 nextTime += 3600 * 24;
//                 await setNextBlockTimestamp(nextTime);
//
//                 let maturityDate = nextTime + 3600 * 24 * 30;
//                 await receivableContract
//                     .connect(borrower)
//                     .createReceivable(1, borrowAmount, maturityDate, "");
//                 let tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);
//                 console.log(`tokenId: ${tokenId}`);
//                 await receivableContract
//                     .connect(borrower)
//                     .approve(creditContract.address, tokenId);
//                 await creditContract
//                     .connect(borrower)
//                     .drawdownWithReceivable(
//                         borrower.address,
//                         { receivableAmount: borrowAmount, receivableId: tokenId },
//                         borrowAmount,
//                     );
//             }
//         });
//
//         it("Month1 - Day6 ~ Day7: adjust committed to borrowAmount * 5", async function () {
//             // Day6
//             nextTime += 3600 * 24;
//             await setNextBlockTimestamp(nextTime);
//
//             await creditContract
//                 .connect(eaServiceAccount)
//                 .updateLimitAndCommitment(borrower.address, creditLimit, borrowAmount.mul(5));
//
//             // Day7
//             nextTime += 3600 * 24;
//             await mineNextBlockWithTimestamp(nextTime);
//         });
//
//         it("Month1 - Day8 ~ Day14: make payment and drawdown together", async function () {
//             // Day8 - Day12 loop
//             for (let i = 0; i < 5; i++) {
//                 // move forward 1 day
//                 nextTime += 3600 * 24;
//                 await setNextBlockTimestamp(nextTime);
//
//                 let maturityDate = nextTime + 3600 * 24 * 30;
//                 await receivableContract
//                     .connect(borrower)
//                     .createReceivable(1, borrowAmount, maturityDate, "");
//                 let tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);
//                 console.log(`tokenId: ${tokenId}`);
//                 await receivableContract
//                     .connect(borrower)
//                     .approve(creditContract.address, tokenId);
//
//                 await creditContract
//                     .connect(borrower)
//                     .makePrincipalPaymentAndDrawdownWithReceivable(
//                         borrower.address,
//                         tokenId.sub(5),
//                         paymentAmount,
//                         { receivableAmount: borrowAmount, receivableId: tokenId },
//                         borrowAmount,
//                     );
//             }
//
//             // Day13, Day14
//             nextTime += 3600 * 24 * 2;
//             await mineNextBlockWithTimestamp(nextTime);
//         });
//
//         it("Month1 - Day15 ~ Day21: make payment and drawdown together", async function () {
//             // Day15 - Day20 loop
//             for (let i = 0; i < 5; i++) {
//                 // move forward 1 day
//                 nextTime += 3600 * 24;
//                 await setNextBlockTimestamp(nextTime);
//
//                 let maturityDate = nextTime + 3600 * 24 * 30;
//                 await receivableContract
//                     .connect(borrower)
//                     .createReceivable(1, borrowAmount, maturityDate, "");
//                 let tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);
//                 console.log(`tokenId: ${tokenId}`);
//                 await receivableContract
//                     .connect(borrower)
//                     .approve(creditContract.address, tokenId);
//
//                 await creditContract
//                     .connect(borrower)
//                     .makePrincipalPaymentAndDrawdownWithReceivable(
//                         borrower.address,
//                         tokenId.sub(5),
//                         paymentAmount,
//                         { receivableAmount: borrowAmount, receivableId: tokenId },
//                         borrowAmount,
//                     );
//             }
//
//             // Day21, Day22
//             nextTime += 3600 * 24 * 2;
//             await mineNextBlockWithTimestamp(nextTime);
//         });
//
//         it("Month1 - Day22 ~ Day28: make payment and drawdown together", async function () {
//             // Day22 - Day26 loop
//             for (let i = 0; i < 5; i++) {
//                 // move forward 1 day
//                 nextTime += 3600 * 24;
//                 await setNextBlockTimestamp(nextTime);
//
//                 let maturityDate = nextTime + 3600 * 24 * 30;
//                 await receivableContract
//                     .connect(borrower)
//                     .createReceivable(1, borrowAmount, maturityDate, "");
//                 let tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);
//                 console.log(`tokenId: ${tokenId}`);
//                 await receivableContract
//                     .connect(borrower)
//                     .approve(creditContract.address, tokenId);
//
//                 await creditContract
//                     .connect(borrower)
//                     .makePrincipalPaymentAndDrawdownWithReceivable(
//                         borrower.address,
//                         tokenId.sub(5),
//                         paymentAmount,
//                         { receivableAmount: borrowAmount, receivableId: tokenId },
//                         borrowAmount,
//                     );
//             }
//
//             // Day27, Day28
//             nextTime += 3600 * 24 * 2;
//             await mineNextBlockWithTimestamp(nextTime);
//         });
//
//         it("Month2 - Day1: pay Month1's yield", async function () {
//             // Day1
//             nextTime =
//                 (
//                     await calendarContract.getStartDateOfNextPeriod(
//                         CONSTANTS.PERIOD_DURATION_MONTHLY,
//                         nextTime,
//                     )
//                 ).toNumber() + 100;
//             await setNextBlockTimestamp(nextTime);
//
//             let cr = await creditContract.getCreditRecord(creditHash);
//             await creditContract
//                 .connect(borrower)
//                 .makePaymentWithReceivable(borrower.address, 0, cr.nextDue);
//         });
//
//         it("Month2 - Day1 ~ Day7: make payment and drawdown together", async function () {
//             let block = await getLatestBlock();
//             nextTime = block.timestamp - 3600 * 24 + 100;
//
//             // Day1 - Day5 loop
//             for (let i = 0; i < 5; i++) {
//                 // move forward 1 day
//                 nextTime += 3600 * 24;
//                 await setNextBlockTimestamp(nextTime);
//
//                 let maturityDate = nextTime + 3600 * 24 * 30;
//                 await receivableContract
//                     .connect(borrower)
//                     .createReceivable(1, borrowAmount, maturityDate, "");
//                 let tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);
//                 console.log(`tokenId: ${tokenId}`);
//                 await receivableContract
//                     .connect(borrower)
//                     .approve(creditContract.address, tokenId);
//
//                 await creditContract
//                     .connect(borrower)
//                     .makePrincipalPaymentAndDrawdownWithReceivable(
//                         borrower.address,
//                         tokenId.sub(5),
//                         paymentAmount,
//                         { receivableAmount: borrowAmount, receivableId: tokenId },
//                         borrowAmount,
//                     );
//             }
//
//             // Day6, Day7
//             nextTime += 3600 * 24 * 2;
//             await mineNextBlockWithTimestamp(nextTime);
//         });
//
//         it("Month2 - Day8 ~ Day12: make payment and drawdown together", async function () {
//             // Day8 - Day12 loop
//             for (let i = 0; i < 5; i++) {
//                 // move forward 1 day
//                 nextTime += 3600 * 24;
//                 await setNextBlockTimestamp(nextTime);
//
//                 let maturityDate = nextTime + 3600 * 24 * 30;
//                 await receivableContract
//                     .connect(borrower)
//                     .createReceivable(1, borrowAmount, maturityDate, "");
//                 let tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);
//                 console.log(`tokenId: ${tokenId}`);
//                 await receivableContract
//                     .connect(borrower)
//                     .approve(creditContract.address, tokenId);
//
//                 await creditContract
//                     .connect(borrower)
//                     .makePrincipalPaymentAndDrawdownWithReceivable(
//                         borrower.address,
//                         tokenId.sub(5),
//                         paymentAmount,
//                         { receivableAmount: borrowAmount, receivableId: tokenId },
//                         borrowAmount,
//                     );
//             }
//         });
//
//         it("Month2 - Day13 ~ Day14: adjust committed to borrowAmount * 10", async function () {
//             // Day6
//             nextTime += 3600 * 24;
//             await setNextBlockTimestamp(nextTime);
//
//             borrowAmount = borrowAmount.mul(2);
//             creditLimit = borrowAmount
//                 .mul(5)
//                 .mul(CONSTANTS.BP_FACTOR.add(500))
//                 .div(CONSTANTS.BP_FACTOR);
//             await creditContract
//                 .connect(eaServiceAccount)
//                 .updateLimitAndCommitment(borrower.address, creditLimit, borrowAmount.mul(5));
//
//             // Day7
//             nextTime += 3600 * 24;
//             await mineNextBlockWithTimestamp(nextTime);
//         });
//
//         it("Month2 - Day15 ~ Day21: make payment and drawdown together", async function () {
//             // Day15 - Day20 loop
//             for (let i = 0; i < 5; i++) {
//                 // move forward 1 day
//                 nextTime += 3600 * 24;
//                 await setNextBlockTimestamp(nextTime);
//
//                 let maturityDate = nextTime + 3600 * 24 * 30;
//                 await receivableContract
//                     .connect(borrower)
//                     .createReceivable(1, borrowAmount, maturityDate, "");
//                 let tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);
//                 console.log(`tokenId: ${tokenId}`);
//                 await receivableContract
//                     .connect(borrower)
//                     .approve(creditContract.address, tokenId);
//
//                 await creditContract
//                     .connect(borrower)
//                     .makePrincipalPaymentAndDrawdownWithReceivable(
//                         borrower.address,
//                         tokenId.sub(5),
//                         paymentAmount,
//                         { receivableAmount: borrowAmount, receivableId: tokenId },
//                         borrowAmount,
//                     );
//             }
//
//             // Day21, Day22
//             nextTime += 3600 * 24 * 2;
//             await mineNextBlockWithTimestamp(nextTime);
//
//             paymentAmount = borrowAmount;
//         });
//
//         it("Month3 - Day6: refresh credit and credit state becomes Delayed", async function () {
//             // Day6
//             nextTime =
//                 (
//                     await calendarContract.getStartDateOfNextPeriod(
//                         CONSTANTS.PERIOD_DURATION_MONTHLY,
//                         nextTime,
//                     )
//                 ).toNumber() +
//                 3600 * 24 * 6 +
//                 100;
//             await setNextBlockTimestamp(nextTime);
//
//             await creditContract.refreshCredit(borrower.address);
//             let cr = await creditContract.getCreditRecord(creditHash);
//             printCreditRecord("cr", cr);
//
//             // Calling makePrincipalPaymentAndDrawdownWithReceivable fails
//             let maturityDate = nextTime + 3600 * 24 * 30;
//             await receivableContract
//                 .connect(borrower)
//                 .createReceivable(1, borrowAmount, maturityDate, "");
//             let tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);
//             console.log(`tokenId: ${tokenId}`);
//             await receivableContract.connect(borrower).approve(creditContract.address, tokenId);
//
//             await expect(
//                 creditContract
//                     .connect(borrower)
//                     .makePrincipalPaymentAndDrawdownWithReceivable(
//                         borrower.address,
//                         tokenId.sub(5),
//                         paymentAmount,
//                         { receivableAmount: borrowAmount, receivableId: tokenId },
//                         borrowAmount,
//                     ),
//             ).to.be.revertedWithCustomError(creditContract, "creditNotInStateForDrawdown");
//         });
//
//         it("Month3 - Day7: pay yield including late fee", async function () {
//             // Day7
//             nextTime += 3600 * 24;
//             await setNextBlockTimestamp(nextTime);
//
//             let cr = await creditContract.getCreditRecord(creditHash);
//             let dd = await creditContract.getDueDetail(creditHash);
//             let [lateUpdated, lateFee] = await calcLateFeeNew(
//                 poolConfigContract,
//                 calendarContract,
//                 cr,
//                 dd,
//                 timestampToMoment(nextTime),
//                 5,
//             );
//             await creditContract
//                 .connect(borrower)
//                 .makePaymentWithReceivable(
//                     borrower.address,
//                     0,
//                     cr.nextDue.add(cr.totalPastDue.sub(dd.lateFee)).add(lateFee),
//                 );
//             cr = await creditContract.getCreditRecord(creditHash);
//             printCreditRecord("cr", cr);
//         });
//
//         it("Month3 - Day7: make payment and drawdown together", async function () {
//             let tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);
//             console.log(`tokenId: ${tokenId}`);
//
//             await creditContract
//                 .connect(borrower)
//                 .makePrincipalPaymentAndDrawdownWithReceivable(
//                     borrower.address,
//                     tokenId.sub(5),
//                     paymentAmount,
//                     { receivableAmount: borrowAmount, receivableId: tokenId },
//                     borrowAmount,
//                 );
//         });
//     });
// });