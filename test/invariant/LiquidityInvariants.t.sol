// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {BaseInvariants, PoolDeployParameters} from "./BaseInvariants.sol";
import {LiquidityHandler} from "./handlers/LiquidityHandler.sol";
import {CreditLineHandler} from "./handlers/CreditLineHandler.sol";
import {CreditLine} from "contracts/credit/CreditLine.sol";
import {CreditLineManager} from "contracts/credit/CreditLineManager.sol";

import "forge-std/console.sol";

contract LiquidityInvariants is BaseInvariants {
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
        addSelector(liquidityHandler.withdrawPoolOwnerFee.selector, "withdrawPoolOwnerFee");
        addSelector(liquidityHandler.withdrawEAFee.selector, "withdrawEAFee");
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

    function invariant_Tranche_A() public {
        _assert_Tranche_A();
    }

    function invariant_Tranche_B() public {
        _assert_Tranche_B();
    }

    function invariant_Tranche_C() public {
        _assert_Tranche_C();
    }

    function invariant_Tranche_D_E_F() public {
        _assert_Tranche_D_E_F();
    }

    function invariant_Tranche_G() public {
        _assert_Tranche_G();
    }

    function invariant_Tranche_H_I() public {
        _assert_Tranche_H_I();
    }

    function invariant_Tranche_J() public {
        _assert_Tranche_J();
    }

    function invariant_EpochManager_A() public {
        _assert_EpochManager_A();
    }

    function invariant_EpochManager_B_C_D_E_F_G() public {
        _assert_EpochManager_B_C_D_E_F_G();
    }

    function invariant_PoolFeeManager_A() public {
        _assert_PoolFeeManager_A();
    }

    function invariant_PoolFeeManager_B() public {
        _assert_PoolFeeManager_B();
    }

    function invariant_PoolFeeManager_C() public {
        _assert_PoolFeeManager_C();
    }

    function invariant_PoolFeeManager_D() public {
        _assert_PoolFeeManager_D();
    }

    function invariant_FLC_A() public {
        _assert_FLC_A();
    }

    function invariant_FLC_B() public {
        _assert_FLC_B();
    }

    function invariant_FLC_C() public {
        _assert_FLC_C();
    }

    function invariant_FLC_D() public {
        _assert_FLC_D();
    }

    function test_Tranche_invariants() public {
        _assert_Tranche_A();
        _assert_Tranche_B();
        _assert_Tranche_D_E_F();
        _assert_Tranche_G();
        _assert_Tranche_H_I();
        _assert_Tranche_J();
    }

    function test_EpochManager_invariants() public {
        _assert_EpochManager_A();
        _assert_EpochManager_B_C_D_E_F_G();
    }

    function test_PoolFeeManager_invariants() public {
        _assert_PoolFeeManager_A();
        _assert_PoolFeeManager_B();
        _assert_PoolFeeManager_C();
        _assert_PoolFeeManager_D();
    }

    function test_FLC_invariants() public {
        _assert_FLC_A();
        _assert_FLC_B();
        _assert_FLC_C();
        _assert_FLC_D();
    }
}
