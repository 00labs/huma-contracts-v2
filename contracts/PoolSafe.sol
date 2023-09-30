// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {IFirstLossCover} from "./interfaces/IFirstLossCover.sol";
import {IPoolFeeManager} from "./interfaces/IPoolFeeManager.sol";
import {PoolConfig} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {Errors} from "./Errors.sol";

contract PoolSafe is PoolConfigCache, IPoolSafe {
    IERC20 public underlyingToken;
    IFirstLossCover[] internal _firstLossCovers;
    IPoolFeeManager public poolFeeManager;

    uint96 public reservedForRedemption;

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.underlyingToken();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        underlyingToken = IERC20(addr);

        addr = _poolConfig.poolFeeManager();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolFeeManager = IPoolFeeManager(addr);

        address[16] memory covers = _poolConfig.getFirstLossCovers();
        for (uint256 i; i < covers.length; i++) {
            if (covers[i] != address(0)) _firstLossCovers.push(IFirstLossCover(covers[i]));
            else break;
        }
    }

    function deposit(address from, uint256 amount) external {
        poolConfig.onlyTrancheVaultOrFirstLossCoverOrCreditOrPoolFeeManager(msg.sender);

        underlyingToken.transferFrom(from, address(this), amount);
    }

    function withdraw(address to, uint256 amount) external {
        poolConfig.onlyTrancheVaultOrFirstLossCoverOrCreditOrPoolFeeManager(msg.sender);

        underlyingToken.transfer(to, amount);
    }

    function setRedemptionReserve(uint256 reserve) external {
        poolConfig.onlyPool(msg.sender);

        reservedForRedemption = uint96(reserve);
    }

    function getAvailableLiquidity() external view returns (uint256 assets) {
        assets = totalAssets();
        uint96 tempReservedForRedemption = reservedForRedemption;
        assets = assets > tempReservedForRedemption ? assets - tempReservedForRedemption : 0;
    }

    function getAvailableReservation() external view returns (uint256 assets) {
        assets = totalAssets();
        uint96 tempReservedForRedemption = reservedForRedemption;
        assets = assets < tempReservedForRedemption ? assets : tempReservedForRedemption;
    }

    function getPoolAssets() external view returns (uint256 assets) {
        return totalAssets();
    }

    function totalAssets() public view returns (uint256 assets) {
        uint256 reserved;
        uint256 len = _firstLossCovers.length;
        for (uint256 i; i < len; i++) {
            reserved += _firstLossCovers[i].totalAssets();
        }
        reserved += poolFeeManager.getTotalAvailableFees();
        uint256 balance = underlyingToken.balanceOf(address(this));
        return balance > reserved ? balance - reserved : 0;
    }

    function getFirstLossCovers() external view returns (IFirstLossCover[] memory) {
        return _firstLossCovers;
    }
}
