// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {PoolConfig, PoolSettings} from "contracts/common/PoolConfig.sol";
import {TrancheVault} from "contracts/liquidity/TrancheVault.sol";
import {MockToken} from "contracts/common/mock/MockToken.sol";
import {Pool} from "contracts/liquidity/Pool.sol";

import {Test} from "forge-std/Test.sol";

contract TrancheVaultHandler is Test {
    TrancheVault[] tranches;
    address[] lenders;
    MockToken mockToken;
    Pool pool;
    address poolSafe;

    uint256 minDepositAmount;

    constructor(address _poolConfig, address[] memory _lenders) {
        PoolConfig poolConfig = PoolConfig(_poolConfig);
        tranches.push(TrancheVault(poolConfig.juniorTranche()));
        tranches.push(TrancheVault(poolConfig.seniorTranche()));
        pool = Pool(poolConfig.pool());
        poolSafe = poolConfig.poolSafe();
        mockToken = MockToken(poolConfig.underlyingToken());
        lenders = _lenders;
        minDepositAmount = poolConfig.getPoolSettings().minDepositAmount;
    }

    function deposit(uint256 trancheSeed, uint256 lenderSeed, uint256 amount) public {
        uint256 trancheIndex = _bound(trancheSeed, 0, tranches.length - 1);
        TrancheVault tranche = tranches[trancheIndex];
        address lender = lenders[_bound(lenderSeed, 0, lenders.length - 1)];
        uint256 maxDepositAmount = pool.getTrancheAvailableCap(trancheIndex);
        if (minDepositAmount > maxDepositAmount) {
            return;
        }
        uint256 depositAmount = _bound(amount, minDepositAmount, maxDepositAmount);
        vm.startPrank(lender);
        mockToken.mint(lender, depositAmount);
        mockToken.approve(poolSafe, depositAmount);
        tranche.deposit(depositAmount, lender);
        vm.stopPrank();
    }
}
