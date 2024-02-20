// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {Utils} from "../Utils.sol";
import {BaseInvariants} from "../BaseInvariants.sol";
import {PoolConfig} from "contracts/common/PoolConfig.sol";
import {MockToken} from "contracts/common/mock/MockToken.sol";
import {EpochManager} from "contracts/liquidity/EpochManager.sol";
import {TrancheVault} from "contracts/liquidity/TrancheVault.sol";
import {PoolFeeManager} from "contracts/liquidity/PoolFeeManager.sol";
import {FirstLossCover} from "contracts/liquidity/FirstLossCover.sol";
import {PoolSafe} from "contracts/liquidity/PoolSafe.sol";
import {SENIOR_TRANCHE, JUNIOR_TRANCHE, ADMIN_LOSS_COVER_INDEX} from "contracts/common/SharedDefs.sol";

import {Test} from "forge-std/Test.sol";
import "forge-std/console.sol";

contract BaseHandler is Test, Utils {
    uint256 immutable decimals;

    BaseInvariants baseInvariants;

    MockToken mockToken;
    PoolConfig poolConfig;
    EpochManager epochManager;
    TrancheVault[] tranches;
    PoolFeeManager poolFeeManager;
    FirstLossCover adminFLC;
    PoolSafe poolSafe;

    address sentinelServiceAccount;
    address humaTreasury;
    address poolOwnerTreasury;
    address evaluationAgent;
    address poolOwner;

    modifier logCall(bytes4 selector) {
        uint256 callNum = baseInvariants.increaselogCall(selector);
        string memory name = baseInvariants.names(selector);
        console.log("%s starts... callNum: %s, timestmap: %s", name, callNum, vm.unixTime());
        _;
        console.log("%s done... callNum: %s, timestmap: %s", name, callNum, vm.unixTime());
        console.log("--------------------");
    }

    modifier advanceTimestamp(uint256 timeSeed) {
        console.log(
            "before currentEpochEndTime: %s, block.timestamp: %s",
            baseInvariants.currentEpochEndTime(),
            block.timestamp
        );
        baseInvariants.advanceTimestamp(timeSeed);

        _;

        console.log(
            "after currentEpochEndTime: %s, block.timestamp: %s",
            baseInvariants.currentEpochEndTime(),
            block.timestamp
        );
    }

    constructor() {
        baseInvariants = BaseInvariants(msg.sender);
        poolConfig = baseInvariants.poolConfig();
        poolOwner = baseInvariants.poolOwner();

        mockToken = MockToken(poolConfig.underlyingToken());
        epochManager = EpochManager(poolConfig.epochManager());
        tranches.push(TrancheVault(poolConfig.seniorTranche()));
        tranches.push(TrancheVault(poolConfig.juniorTranche()));
        poolFeeManager = PoolFeeManager(poolConfig.poolFeeManager());
        adminFLC = FirstLossCover(poolConfig.getFirstLossCover(ADMIN_LOSS_COVER_INDEX));
        poolSafe = PoolSafe(poolConfig.poolSafe());

        sentinelServiceAccount = poolConfig.humaConfig().sentinelServiceAccount();
        humaTreasury = poolConfig.humaConfig().humaTreasury();
        poolOwnerTreasury = poolConfig.poolOwnerTreasury();
        evaluationAgent = poolConfig.evaluationAgent();

        decimals = mockToken.decimals();
    }

    function boundNew(uint256 x, uint256 min, uint256 max) public pure returns (uint256 result) {
        result = _boundNew(x, min, max);
    }

    function _removeItem(address[] storage array, uint256 index) internal {
        uint256 len = array.length;
        array[index] = array[len - 1];
        array.pop();
    }

    function _toToken(uint256 amount) internal view returns (uint256) {
        return _toToken(amount, decimals);
    }
}
