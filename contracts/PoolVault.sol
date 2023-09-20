// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";
import {IFirstLossCover} from "./interfaces/IFirstLossCover.sol";
import {PoolConfig} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {Errors} from "./Errors.sol";

contract PoolVault is PoolConfigCache, IPoolVault {
    struct Reserves {
        uint96 forRedemption;
        uint96 forPlatformFees;
    }

    IERC20 public underlyingToken;
    IFirstLossCover[] internal _firstLossCovers;

    Reserves public reserves;

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address assetAddress = _poolConfig.underlyingToken();
        if (assetAddress == address(0)) revert Errors.zeroAddressProvided();
        underlyingToken = IERC20(assetAddress);

        address[16] memory covers = _poolConfig.getFirstLossCovers();
        for (uint256 i = 0; i < covers.length; i++) {
            if (covers[i] != address(0)) _firstLossCovers.push(IFirstLossCover(covers[i]));
            else break;
        }
    }

    function deposit(address from, uint256 amount) external {
        poolConfig.onlyTrancheVaultOrFirstLossCoverOrCredit(msg.sender);

        underlyingToken.transferFrom(from, address(this), amount);
    }

    function withdraw(address to, uint256 amount) external {
        poolConfig.onlyTrancheVaultOrFirstLossCoverOrCredit(msg.sender);

        underlyingToken.transfer(to, amount);
    }

    function addPlatformFeesReserve(uint256 reserve) external {
        poolConfig.onlyPlatformFeeManager(msg.sender);

        Reserves memory rs = reserves;
        rs.forPlatformFees += uint96(reserve);
        reserves = rs;
    }

    function withdrawFees(address to, uint256 amount) external {
        poolConfig.onlyPlatformFeeManager(msg.sender);

        Reserves memory rs = reserves;
        rs.forPlatformFees -= uint96(amount);
        reserves = rs;
        underlyingToken.transfer(to, amount);
    }

    function setRedemptionReserve(uint256 reserve) external {
        poolConfig.onlyPool(msg.sender);

        Reserves memory rs = reserves;
        rs.forRedemption = uint96(reserve);
        reserves = rs;
    }

    function getAvailableLiquidity() external view returns (uint256 assets) {
        assets = totalAssets();
        Reserves memory rs = reserves;
        uint256 reserve = rs.forRedemption + rs.forPlatformFees;
        assets = assets > reserve ? assets - reserve : 0;
    }

    function getAvailableReservation() external view returns (uint256 assets) {
        assets = totalAssets();
        Reserves memory rs = reserves;
        uint256 reserve = rs.forRedemption + rs.forPlatformFees;
        assets = assets < reserve ? assets : reserve;
    }

    function getPoolAssets() external view returns (uint256 assets) {
        assets = totalAssets();
        Reserves memory rs = reserves;
        assets = assets > rs.forPlatformFees ? assets - rs.forPlatformFees : 0;
    }

    function totalAssets() public view returns (uint256 assets) {
        uint256 firstLossCoverAssets;
        uint256 len = _firstLossCovers.length;
        for (uint256 i = 0; i < len; i++) {
            firstLossCoverAssets += _firstLossCovers[i].totalAssets();
        }
        uint256 balance = underlyingToken.balanceOf(address(this));
        return balance > firstLossCoverAssets ? balance - firstLossCoverAssets : 0;
    }

    function getFirstLossCovers() external view returns (IFirstLossCover[] memory) {
        return _firstLossCovers;
    }
}
