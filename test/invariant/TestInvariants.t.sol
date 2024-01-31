// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {BaseInvariants, PoolDeployParameters} from "./BaseInvariants.sol";
import {LiquidityHandler} from "./handlers/LiquidityHandler.sol";
import {CreditLineHandler} from "./handlers/CreditLineHandler.sol";
import {CreditLine} from "contracts/credit/CreditLine.sol";
import {CreditLineManager} from "contracts/credit/CreditLineManager.sol";

import "forge-std/console.sol";

contract TestInvariants is BaseInvariants {
    uint96 constant MAX_CREDIT_LIMIT = 10_000_000;
    uint96 constant LIQUIDITY_CAP = 10_000_000;
    uint16 constant FIXED_SENIOR_YIELD_BPS = 1000;
    uint16 constant RISK_ADJUSTED_BPS = 1500;
    uint16 constant CREDIT_YIELD_BPS = 1500;

    LiquidityHandler liquidityHandler;
    CreditLineHandler creditLineHandler;

    function setUp() public override {
        super.setUp();

        _setUp(
            PoolDeployParameters({
                tranchesPolicyType: FIXED_SENIOR_YIELD_TRANCHES_POLICY,
                creditType: CREDIT_LINE,
                maxCreditLimit: MAX_CREDIT_LIMIT,
                liquidityCap: LIQUIDITY_CAP,
                fixedSeniorYieldBps: FIXED_SENIOR_YIELD_BPS,
                riskAdjustedBps: RISK_ADJUSTED_BPS,
                creditYieldBps: CREDIT_YIELD_BPS
            }),
            10,
            10
        );

        liquidityHandler = new LiquidityHandler(lenders);
        creditLineHandler = new CreditLineHandler(borrowers);
        creditLineHandler.approveBorrowers(_toToken(MAX_CREDIT_LIMIT) / 2, CREDIT_YIELD_BPS);

        addSelector(liquidityHandler.deposit.selector, "deposit");
        addSelector(liquidityHandler.addRedemptionRequest.selector, "addRedemptionRequest");
        addSelector(liquidityHandler.cancelRedemptionRequest.selector, "cancelRedemptionRequest");
        addSelector(liquidityHandler.disburse.selector, "disburse");
        addSelector(liquidityHandler.processYieldForLenders.selector, "processYieldForLenders");
        addSelector(liquidityHandler.withdrawProtocolFee.selector, "withdrawProtocolFee");
        addSelector(liquidityHandler.withdrawProtocolFee.selector, "withdrawProtocolFee");
        addSelector(liquidityHandler.withdrawProtocolFee.selector, "withdrawProtocolFee");
        addSelector(creditLineHandler.drawdown.selector, "drawdown");
        addSelector(creditLineHandler.makePayment.selector, "makePayment");
        addSelector(creditLineHandler.refreshCredit.selector, "refreshCredit");

        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = selectors[1] = selectors[2] = liquidityHandler.deposit.selector;
        selectors[3] = selectors[4] = liquidityHandler.addRedemptionRequest.selector;
        selectors[5] = liquidityHandler.cancelRedemptionRequest.selector;
        selectors[6] = liquidityHandler.disburse.selector;
        selectors[7] = liquidityHandler.processYieldForLenders.selector;
        selectors[8] = liquidityHandler.withdrawProtocolFee.selector;
        selectors[9] = liquidityHandler.withdrawPoolOwnerFee.selector;
        selectors[10] = liquidityHandler.withdrawEAFee.selector;
        targetSelector(FuzzSelector({addr: address(liquidityHandler), selectors: selectors}));
        targetContract(address(liquidityHandler));

        selectors = new bytes4[](6);
        selectors[0] = selectors[1] = selectors[2] = creditLineHandler.drawdown.selector;
        selectors[3] = selectors[4] = creditLineHandler.makePayment.selector;
        selectors[5] = creditLineHandler.refreshCredit.selector;
        targetSelector(FuzzSelector({addr: address(creditLineHandler), selectors: selectors}));
        targetContract(address(creditLineHandler));
    }

    function testBoundNew1() public {
        uint256 result = liquidityHandler.boundNew(10089, 1000000, 1000000);
        assertEq(result, 1000000);
    }

    function testBoundNew2() public {
        uint256 result = liquidityHandler.boundNew(0, 1000000, 445809192099);
        assertEq(result, 1000000);
    }

    function testDebug() public {
        // handler.disburse(511, 18732, 1115958799);
        // handler.drawdown(
        //     115792089237316195423570985008687907853269984665640564039457584007913129639933,
        //     0,
        //     115792089237316195423570985008687907853269984665640564039457584007913129639934
        // );
        // handler.drawdown(4773, 9503, 15334);
        // handler.makePayment(
        //     115792089237316195423570985008687907853269984665640564039457584007913129639935,
        //     115792089237316195423570985008687907853269984665640564039457584007913129639934,
        //     115792089237316195423570985008687907853269984665640564039457584007913129639935
        // );
        // handler.cancelRedemptionRequest(
        //     307351878326496349646861946412211957386772448903113552090633114,
        //     2,
        //     115792089237316195423570985008687907853269984665640564039457584007913129639933,
        //     115792089237316195423570985008687907853269984665640564039457584007913129639935
        // );
        // handler.drawdown(
        //     12965627532955235,
        //     115792089237316195423570985008687907853269984665640564039457584007913129639935,
        //     34271968774548698554216071258149267
        // );
        // handler.addRedemptionRequest(10467, 14373, 12718, 19180);
        // handler.drawdown(
        //     4696101871635116613687179390375553842905116356921,
        //     115792089237316195423570985008687907853269984665640564039457584007913129639934,
        //     0
        // );
        // handler.cancelRedemptionRequest(
        //     3,
        //     142865224980,
        //     3203463038928617776283565669072150091243907203013574266905857603663,
        //     9629713799523486109640678726817266933822504961979653993916971138404029
        // );
        // handler.deposit(
        //     115792089237316195423570985008687907853269984665640564039457584007913129639934,
        //     196169082861832774685458594841127741270096699,
        //     1,
        //     115792089237316195423570985008687907853269984665640564039457584007913129639932
        // );
        // _assert_Tranche_H_I();
    }

    function invariant_displayCallsLog() public view {
        displayCallsLog();
    }
}
